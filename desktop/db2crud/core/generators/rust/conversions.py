"""The conversions between the application models and the tables (conversions/plan.py), written in Rust: per table, a
module with one function that turns a model into what the service takes (its create DTO, or the entity) and one that
turns what it returns into the model. Values are converted between the model's Rust types and the column's (numbers
of another size, decimals, text, chrono's dates and times, `Option`, enums by a `match`), so the crate compiles
without warnings; lookups go through the repositories of the unit of work (those functions are `async` and return
`Result<_, DomainError>`); Mapper's transformations are plain expressions; what the plan leaves to the user is a
`// TODO:` with the reason, or `todo!()` where a value is needed. Mirrors web/src/core/generators/rust/conversions.ts.

Functions take references and clone what is not `Copy`. Models are built with a struct literal. They are copied into
the crate (`settings.modelsModule`, `app` standing for the crate) or, with `modelsSource: import`, used from the user's
module: the copy then goes to `application-models/mod.rs`, which `lib.rs` declares with `#[path]` while the project
runs on its own (declare your module there inside the application)."""

import re

from ...conversions.plan import without_hidden
from ...js import js_string
from .context import column_of, file_of, find_info, module_of, path_in, query, query_name, rs_file, stored
from .dtos import create_dto, read_columns, read_dto
from .rust import RsUses, rs_string, snake_name, type_name

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they are imported from the user's module."""


def models_module(context: dict) -> str:
    """The module of the application models in the crate: `app.application_models` → `crate::application_models`."""
    return "::".join(["crate", *(snake_name(part) for part in context["settings"]["modelsModule"].split(".")[1:])])


def _uses_dtos(context: dict, info: dict) -> bool:
    settings = context["settings"]
    return (
        settings["services"]
        and settings["serviceTypes"] == "dtos"
        and info["service"] is not None
        and info["role"] == "entity"
    )


def service_plans(context: dict, plans: list[dict]) -> list[dict]:
    """The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them."""
    result = []
    for plan in plans:
        info = find_info(context, plan["table"])
        result.append(without_hidden(plan, info["hidden"]) if info and _uses_dtos(context, info) else plan)
    return result


def conversions_module(context: dict, info: dict) -> str:
    """The module of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"crate::{info['attr']}::conversions"
    return f"crate::conversions::{info['module']}"


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its functions, the types they take and return, and the name the model is used by (an
    alias, `ProductModel`, when it is named like the entity or a DTO of the same module)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    clash = plan["model"] in (info["entity"], target, source)
    model = f"{plan['model']}Model" if clash else plan["model"]
    return {
        "write": f"{snake_name(model)}_to_{snake_name(target)}",
        "read": f"{snake_name(source)}_to_{snake_name(model)}",
        "target": target,
        "source": source,
        "model": model,
        "clash": clash,
    }


# Types of the models


def _from_rust(model: dict) -> bool:
    """A model read from Rust keeps its names and types; the others get Rust's."""
    return any(field.get("originalType") is not None for field in model["fields"])


def _member_of(model: dict | None, name: str) -> str:
    return name if model is not None and _from_rust(model) else snake_name(name)


_SHORT = {
    "Decimal": "rust_decimal::Decimal",
    "NaiveDate": "chrono::NaiveDate",
    "NaiveTime": "chrono::NaiveTime",
    "NaiveDateTime": "chrono::NaiveDateTime",
    "Utc": "chrono::Utc",
    "FixedOffset": "chrono::FixedOffset",
    "DateTime": "chrono::DateTime",
    "Uuid": "uuid::Uuid",
}


def _canonical(type_text: str) -> str:
    """A type with the paths of the crates it names: `DateTime<Utc>` → `chrono::DateTime<chrono::Utc>`."""
    text = re.sub(r"\s+", "", type_text).replace(",", ", ")
    return re.sub(r"(?<![\w:])([A-Z]\w*)", lambda match: _SHORT.get(match.group(1), match.group(1)), text)


_PRIMITIVE_RS = {
    "string": "String",
    "decimal": "rust_decimal::Decimal",
    "boolean": "bool",
    "date": "chrono::NaiveDate",
    "datetime": "chrono::DateTime<chrono::Utc>",
    "time": "chrono::NaiveTime",
    "duration": "i64",
    "uuid": "String",
    "binary": "Vec<u8>",
    "any": "String",
}


def _type_ref_rs(type_ref: dict) -> str:
    """The Rust type of a model's TypeRef, for models not read from Rust."""
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        bits = type_ref.get("bits")
        if name == "integer":
            return "i32" if bits in (8, 16, 32) else "i64"
        if name == "float":
            return "f32" if bits == 32 else "f64"
        return _PRIMITIVE_RS[name]
    if kind == "array":
        return f"Vec<{_type_ref_rs(type_ref['items'])}>"
    if kind == "map":
        return f"std::collections::HashMap<String, {_type_ref_rs(type_ref['value'])}>"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "String"


def _field_rs(model: dict | None, field: dict) -> str:
    """The Rust type of a field, as the model has it (`Option<…>` when it may be null)."""
    if model is not None and _from_rust(model) and field.get("originalType"):
        return _canonical(field["originalType"])
    type_text = _type_ref_rs(field["type"])
    return f"Option<{type_text}>" if field.get("nullable") or field.get("optional") else type_text


def _variant(item: dict, value: dict) -> str:
    """The variant of an enum value in Rust."""
    if all(re.match(r"^[A-Z][A-Za-z0-9]*$", other["name"]) for other in item["values"]):
        return value["name"]
    return type_name(value["name"])


def _enum_text(value: dict) -> str:
    """The text an enum value is stored as: its string value, or its name."""
    return value["value"] if isinstance(value.get("value"), str) else value["name"]


def _closure(schema: dict, names: list[str]) -> tuple[list[dict], list[dict]]:
    """The models and enums a set of models needs, in the order of the schema."""
    models: set[str] = set()
    enums: set[str] = set()

    def visit(type_ref: dict) -> None:
        if type_ref["kind"] == "array":
            visit(type_ref["items"])
        elif type_ref["kind"] == "map":
            visit(type_ref["value"])
        elif type_ref["kind"] == "enum":
            enums.add(type_ref["name"])
        elif type_ref["kind"] == "model":
            add(type_ref["name"])

    def add(name: str) -> None:
        model = next((item for item in schema["models"] if item["name"] == name), None)
        if model is None or name in models:
            return
        models.add(name)
        for parent in model.get("extends") or []:
            add(parent)
        for field in model["fields"]:
            visit(field["type"])

    for name in names:
        add(name)
    return (
        [model for model in schema["models"] if model["name"] in models],
        [item for item in schema["enums"] if item["name"] in enums],
    )


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def models_file(context: dict, schema: dict, plans: list[dict]) -> dict:
    """The copy of the application models the conversions use: one module with every struct and enum."""
    models, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    blocks = [
        [
            f"/// {item['name']}, as the application has it.",
            "#[derive(Debug, Clone, Copy, PartialEq)]",
            f"pub enum {item['name']} {{",
            *(f"    {_variant(item, value)}," for value in item["values"]),
            "}",
        ]
        for item in enums
    ]
    blocks += [
        [
            f"/// {model['name']}, as the application has it.",
            "#[derive(Debug, Clone, PartialEq)]",
            f"pub struct {model['name']} {{",
            *(f"    pub {_member_of(model, field['name'])}: {_field_rs(model, field)}," for field in model["fields"]),
            "}",
        ]
        for model in models
    ]
    copied = context["settings"]["modelsSource"] == "copy"
    path = file_of(models_module(context)) if copied else f"{MODELS_FOLDER}/mod.rs"
    body = [line for index, block in enumerate(blocks) for line in ([""] if index > 0 else []) + block]
    return rs_file(path, "", body, ["The application models the conversions use: a copy of the types DB2CRUD read."])


# Values


def _typed(expression: str, type_text: str, optional: bool = False, place: bool = False) -> dict:
    inner = re.match(r"^Option<(.+)>$", type_text)
    return {
        "expression": expression,
        "type": _canonical(inner.group(1) if inner else type_text),
        "optional": optional or inner is not None,
        "place": place,
    }


_INTEGERS = {"i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "isize", "usize"}
_FLOATS = {"f32", "f64"}
_DECIMAL = "rust_decimal::Decimal"
_UTC = "chrono::DateTime<chrono::Utc>"
_FIXED = "chrono::DateTime<chrono::FixedOffset>"
_NAIVE = "chrono::NaiveDateTime"
_COPY = {
    *_INTEGERS,
    *_FLOATS,
    "bool",
    "char",
    _DECIMAL,
    "chrono::NaiveDate",
    "chrono::NaiveTime",
    _NAIVE,
    _UTC,
    _FIXED,
    "uuid::Uuid",
}


def _bare(expression: str) -> str:
    """An expression without the parentheses around all of it, which Rust warns about where a value goes."""
    if not expression.startswith("(") or not expression.endswith(")"):
        return expression
    depth = 0
    for index, char in enumerate(expression):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if depth == 0 and index < len(expression) - 1:
            return expression
    return expression[1:-1]


def _is_copy(models: dict, type_text: str) -> bool:
    return type_text in _COPY or any(item["name"] == type_text for item in models["schema"]["enums"])


def _owned(models: dict, value: dict) -> str:
    """A value moved out of a place: cloned when its type is not `Copy`."""
    if value["place"] and not _is_copy(models, value["type"]):
        return f"{value['expression']}.clone()"
    return value["expression"]


def _is_number(type_text: str) -> bool:
    return type_text in _INTEGERS or type_text in _FLOATS


def _core(models: dict, value: dict, to: str) -> str | None:
    """A value that is there, of one Rust type, as another; None when DB2CRUD does not convert them."""
    source = value["type"]
    expression = _owned(models, value)
    if source == to:
        return expression
    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == to), None)
    for item in (from_enum, to_enum):
        if item and models.get("uses") is not None:
            models["uses"].add(f"{models['module']}::{item['name']}")
    if from_enum and to == "String":
        cases = ", ".join(
            f"{source}::{_variant(from_enum, item)} => {rs_string(_enum_text(item))}.to_string()"
            for item in from_enum["values"]
        )
        return f"match {value['expression']} {{ {cases} }}"
    if to_enum and source == "String":
        cases = ", ".join(
            f"{rs_string(_enum_text(item))} => {to}::{_variant(to_enum, item)}" for item in to_enum["values"]
        )
        return f'match {value["expression"]}.as_str() {{ {cases}, _ => panic!("No {to} for this value") }}'
    if _is_number(source) and _is_number(to):
        return f"{expression} as {to}"
    if _is_number(source) and to == _DECIMAL:
        if source in _FLOATS:
            return (
                "<rust_decimal::Decimal as rust_decimal::prelude::FromPrimitive>::from_f64"
                f'({expression} as f64).expect("a decimal")'
            )
        return f"rust_decimal::Decimal::from({expression})"
    if source == _DECIMAL and _is_number(to):
        method = "to_f64" if to in _FLOATS else "to_i64"
        return f'rust_decimal::prelude::ToPrimitive::{method}(&{expression}).expect("a number") as {to}'
    if to == "String":
        return f"{value['expression']}.to_string()"
    if source == "String":
        return f"{value['expression']}.parse::<{to}>().expect({rs_string(f'a {to}')})"
    pairs = {
        f"{_FIXED}>{_NAIVE}": f"{expression}.naive_utc()",
        f"{_UTC}>{_NAIVE}": f"{expression}.naive_utc()",
        f"{_NAIVE}>{_UTC}": f"{expression}.and_utc()",
        f"{_NAIVE}>{_FIXED}": f"{expression}.and_utc().fixed_offset()",
        f"{_UTC}>{_FIXED}": f"{expression}.fixed_offset()",
        f"{_FIXED}>{_UTC}": f"{expression}.with_timezone(&chrono::Utc)",
        f"{_NAIVE}>chrono::NaiveDate": f"{expression}.date()",
        f"chrono::NaiveDate>{_NAIVE}": f'{expression}.and_hms_opt(0, 0, 0).expect("a time")',
    }
    return pairs.get(f"{source}>{to}")


def _convert(models: dict, value: dict, to: str) -> str | None:
    """A value as another Rust type (`Option<…>` when it may be empty), or None when DB2CRUD does not convert them.
    An empty value stays empty when the target takes it, and is taken as set (`expect`) when it does not."""
    inner = re.match(r"^Option<(.+)>$", to)
    target = _canonical(inner.group(1) if inner else to)
    if not value["optional"]:
        converted = _core(models, value, target)
        if converted is None:
            return None
        return f"Some({_bare(converted)})" if inner else converted
    name = value.get("label") or (re.sub(r"\W", "", re.sub(r"^.*\.", "", value["expression"])) or "value")
    if not inner:
        expected = f"{_owned(models, value)}.expect({rs_string(f'{name} is set')})"
        return _core(models, {**value, "expression": expected, "optional": False, "place": False}, target)
    converted = _core(models, {"expression": "it", "type": value["type"], "optional": False, "place": False}, target)
    if converted is None:
        return None
    return _owned(models, value) if converted == "it" else f"{_owned(models, value)}.map(|it| {converted})"


def _literal(value) -> dict:
    """A Rust literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("None", "String", True)
    if isinstance(value, str):
        return _typed(f"{rs_string(value)}.to_string()", "String")
    if isinstance(value, bool):
        return _typed("true" if value else "false", "bool")
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer()):
        return _typed(f"{js_string(value)}_i64", "i64")
    return _typed(f"{js_string(value)}_f64", "f64")


_INVERSE = {"*": "/", "/": "*", "+": "-", "-": "+"}


def _inverse(transform: dict) -> dict:
    """The transformation that undoes an invertible one."""
    if transform["kind"] == "arithmetic":
        return {**transform, "operator": _INVERSE[transform["operator"]]}
    if transform["kind"] == "enum":
        return {"kind": "enum", "pairs": [{"from": pair["to"], "to": pair["from"]} for pair in transform["pairs"]]}
    return transform


def _text(models: dict, value: dict) -> str:
    """A value as the text Mapper compares: enums by their stored text."""
    converted = _convert(models, value, "String")
    return f"{value['expression']}.to_string()" if converted is None else converted


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(_text(models, item) for item in values)
        return _typed(f"[{parts}].join({rs_string(transform['separator'])})", "String")
    if kind == "split":
        separator = rs_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"rest(&{_text(models, value)}, {separator})", "String")
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"part(&{_text(models, value)}, {separator}, {part})", "String")
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        items = ", ".join(rs_string(item) for item in transform["trueValues"])
        return _typed(f"[{items}].contains(&{_text(models, value)}.as_str())", "bool")
    if kind == "enum":
        body["helpers"].add("pair")
        pairs = ", ".join(f"({rs_string(pair['from'])}, {rs_string(pair['to'])})" for pair in transform["pairs"])
        fallback = f"Some({rs_string(transform['fallback'])})" if transform.get("fallback") is not None else "None"
        return _typed(f"pair(&[{pairs}], &{_text(models, value)}, {fallback})", "String")
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        plain = _canonical(re.sub(r"^Option<(.+)>$", r"\1", target))
        # From a date and time: a number; from a number: a date and time in UTC
        if _is_number(plain) or plain == "String":
            moment = _convert(models, value, _UTC)
            if moment is None:
                return None
            return _typed(f"{moment}.{'timestamp_millis()' if milliseconds else 'timestamp()'}", "i64")
        number = _convert(models, value, "i64")
        if number is None:
            return None
        if milliseconds:
            call = f"chrono::DateTime::from_timestamp_millis({number})"
        else:
            call = f"chrono::DateTime::from_timestamp({number}, 0)"
        return _typed(f'{call}.expect("a time")', _UTC)
    if kind == "arithmetic":
        number = _convert(models, value, "f64")
        if number is None:
            return None
        operand = re.sub(r"_f64$", "", re.sub(r"_i64$", ".0", _literal(transform["operand"])["expression"]))
        return _typed(f"({number} {transform['operator']} {operand})", "f64")
    return None


def _fit(models: dict, result: dict, to: str) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, then converted."""
    plain = _canonical(re.sub(r"^Option<(.+)>$", r"\1", to))
    if plain in _INTEGERS and result["type"] in _FLOATS:
        return _convert(models, {**result, "expression": f"{result['expression']}.round()"}, to)
    return _convert(models, result, to)


# Conversions

_WHY = {
    "pending": "the matching waits for review",
    "noField": "no field of the model gives it",
    "oneWay": "Mapper's relation only goes the other way",
    "unsupported": "DB2CRUD does not write this conversion",
    "hidden": "the service never returns it",
}


def _todo_text(todo: dict) -> str:
    detail = f" ({todo['detail']})" if todo.get("detail") else ""
    return f"{_WHY[todo['reason']]}{detail}"


def _article(name: str) -> str:
    """`A Customer`, `An Order`."""
    return f"{'An' if re.match(r'[AEIOU]', name, re.IGNORECASE) else 'A'} {name}"


def _walk(models: dict, model: dict | None, path: list[str], root: str) -> dict | None:
    """The field of a model a path names, with how it is read, walking nested models."""
    current = model
    result = None
    expression = root
    for part in path:
        field = next((item for item in current["fields"] if item["name"] == part), None) if current else None
        if current is None or field is None or (result and result["optional"]):
            return None
        expression = f"{expression}.{_member_of(current, field['name'])}"
        result = _typed(expression, _field_rs(current, field), False, True)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return result


def _column_typed(column: dict, root: str, entity: bool) -> dict:
    """How a column is read: from a DTO as it is, from an entity as its `Option`."""
    return _typed(f"{root}.{column['field']}", column["rs"], entity or column["column"]["nullable"], True)


def _write_expression(context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": None, "todo": f"{_WHY['unsupported']} ({detail})"}

    def source(path: list[str]) -> dict | None:
        return _walk(models, model, path, "model")

    def finish(result: dict | None) -> dict:
        # DTOs and entities take every value as an Option
        if result is None:
            return unsupported(column["key"])
        converted = _fit(models, result, f"Option<{column['rs']}>")
        if converted is None:
            return unsupported(f"{result['type']} to {column['rs']}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "field":
        return finish(source(value["path"]))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        given = source(value["path"])
        if not other or not finder or not given:
            return {"expression": None, "todo": "no repository query finds the row it names"}
        by = column_of(other, value["by"])
        argument = _convert(models, given, by["rs"])
        if argument is None:
            return unsupported(f"{given['type']} to {by['rs']}")
        name = snake_name(other["entity"])
        models["uses"].add("crate::errors::DomainError")
        body["lines"] += [
            f"let {name} = uow.{other['attr']}().{query_name(context, finder)}({argument}).await?",
            f"    .ok_or_else(|| DomainError::not_found({rs_string(other['entity'])}, &{given['expression']}))?;",
        ]
        return finish(_column_typed(column_of(other, value["key"]), name, True))
    if kind == "mapper":
        sources = [source(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["key"])
        return finish(_transformed(models, value["transform"], sources, column["rs"], body))
    given = source(value["path"])
    return finish(given and _transformed(models, _inverse(value["transform"]), [given], column["rs"], body))


def _read_expression(
    context: dict, models: dict, info: dict, dtos: bool, model: dict, field: dict, value: dict, body: dict
) -> dict:
    target = _field_rs(model, field)

    def own(name: str) -> dict:
        return _column_typed(column_of(info, name), "row", not dtos)

    def unsupported(detail: str) -> dict:
        return {"expression": None, "todo": f"{_WHY['unsupported']} ({detail})"}

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(field["name"])
        converted = _fit(models, result, target)
        if converted is None:
            return unsupported(f"{result['type']} to {target}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "column":
        return finish(own(value["column"]))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = (query(other, "getByKey") or query(other, "findByUnique", [value["key"]])) if other else None
        if not other or not finder:
            return {"expression": None, "todo": "no repository query reads it"}
        name = snake_name(other["entity"])
        key = own(value["column"])
        nullable = column_of(info, value["column"])["column"]["nullable"]
        call = f"uow.{other['attr']}().{query_name(context, finder)}"
        if nullable:
            body["lines"].append(
                f"let {name} = match {key['expression']} {{ Some(key) => {call}(key).await?, None => None }};"
            )
        else:
            argument = _convert(models, key, column_of(info, value["column"])["rs"])
            body["lines"].append(f"let {name} = {call}({argument}).await?;")
        by = column_of(other, value["by"])
        found = _typed(f"{name}.as_ref().and_then(|row| row.{by['field']}.clone())", by["rs"], True)
        return finish({**found, "label": f"{other['name']}.{by['key']}"})
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": None, "todo": "no repository query reads it"}
        item = _column_typed(column_of(other, value["value"]), "item", True)
        found = re.match(r"^Vec<(.+)>$", target)
        element = found.group(1) if found else item["type"]
        converted = _convert(models, {**item, "place": False}, element)
        if converted is None:
            return unsupported(f"{item['type']} to {element}")
        key = _convert(models, own(value["key"]), column_of(info, value["key"])["rs"])
        rows = f"uow.{other['attr']}().{query_name(context, lister)}({key}).await?"
        return {"expression": f"{rows}.into_iter().map(|item| {converted}).collect()"}
    if kind == "mapper":
        return finish(_transformed(models, value["transform"], [own(name) for name in value["columns"]], target, body))
    return finish(_transformed(models, _inverse(value["transform"]), [own(value["column"])], target, body))


_HELPERS = {
    "pair": [
        "/// The value an enum pair gives, or the fallback; a value without a pair is an error.",
        "fn pair(pairs: &[(&str, &str)], value: &str, fallback: Option<&str>) -> String {",
        "    let found = pairs.iter().find(|(from, _)| *from == value).map(|(_, to)| *to).or(fallback);",
        '    found.unwrap_or_else(|| panic!("No pair for {value}")).to_string()',
        "}",
    ],
    "part": [
        "/// One part of a text split by a separator (the last one for -1), or an empty text.",
        "fn part(value: &str, separator: &str, index: i64) -> String {",
        "    let parts: Vec<&str> = value.split(separator).collect();",
        "    let at = if index < 0 { parts.len() as i64 - 1 } else { index };",
        "    parts.get(at as usize).map(|part| part.to_string()).unwrap_or_default()",
        "}",
    ],
    "rest": [
        "/// What follows the first separator of a text, or an empty text.",
        "fn rest(value: &str, separator: &str) -> String {",
        "    value.split_once(separator).map(|(_, rest)| rest.to_string()).unwrap_or_default()",
        "}",
    ],
}


def _comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def _reads_rows(items: list[dict] | None) -> bool:
    """Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work."""
    return any(item["value"]["kind"] in ("lookup", "children") for item in items or [])


def _wrapped(uow: bool, literal: list[str]) -> list[str]:
    if uow:
        return ["    Ok(", *(f"        {line}" for line in literal), "    )"]
    return [f"    {line}" for line in literal]


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The module of the conversions of one table: one function per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    uses = RsUses()
    models = {"schema": schema, "module": models_module(context), "uses": uses}
    helpers: set[str] = set()
    functions: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    kind = "dtos" if dtos else "entity"
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        alias = f" as {names['model']}" if names["clash"] else ""
        uses.add(f"{path_in(models['module'], plan['model'])}{alias}")
        if plan["write"] is not None:
            body = {"lines": [], "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["field"], "expression": None, "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body)
                    values.append({"name": column["field"], **written})
            uses.add(path_in(module_of(context, info, kind), names["target"]))
            uow = _reads_rows(plan["write"])
            if uow:
                uses.add("crate::errors::DomainError", "crate::unit_of_work::UnitOfWork")
            # Every field left out takes its default, None
            literal = [f"{names['target']} {{"]
            for value in values:
                if value["expression"] is None:
                    literal.append(f"    //{_comment(value)[3:]}")
                else:
                    literal.append(f"    {value['name']}: {_bare(value['expression'])},{_comment(value)}")
            literal += ["    ..Default::default()", "}"]
            if uow:
                signature = (
                    f"pub async fn {names['write']}(model: &{names['model']}, uow: &dyn UnitOfWork)"
                    f" -> Result<{names['target']}, DomainError> {{"
                )
            else:
                signature = f"pub fn {names['write']}(model: &{names['model']}) -> {names['target']} {{"
            functions.append(
                [
                    f"/// {_article(plan['model'])} as the {info['name']} table takes it.",
                    signature,
                    *(f"    {line}" for line in body["lines"]),
                    *_wrapped(uow, literal),
                    "}",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = _member_of(model, field["name"])
                optional = _field_rs(model, field).startswith("Option<")
                if item is None:
                    values.append(
                        {"name": name, "expression": "None"}
                        if optional
                        else {"name": name, "expression": None, "todo": "no column gives it"}
                    )
                elif item["value"]["kind"] == "todo":
                    values.append({"name": name, "expression": None, "todo": _todo_text(item["value"])})
                else:
                    read = _read_expression(context, models, info, dtos, model, field, item["value"], body)
                    values.append({"name": name, **read})
            uses.add(path_in(module_of(context, info, kind), names["source"]))
            uow = _reads_rows(plan["read"])
            if uow:
                uses.add("crate::errors::DomainError", "crate::unit_of_work::UnitOfWork")
            pending = any(value["expression"] is None for value in values)
            # todo!() stands for a value left to the user, and says why when it runs
            literal = [f"{names['model']} {{"]
            for value in values:
                if value["expression"] is None:
                    reason = rs_string(f"{value['name']}: {value['todo']}")
                    literal.append(f"    {value['name']}: todo!({reason}),")
                else:
                    literal.append(f"    {value['name']}: {_bare(value['expression'])},{_comment(value)}")
            literal.append("}")
            if uow:
                signature = (
                    f"pub async fn {names['read']}(row: &{names['source']}, uow: &dyn UnitOfWork)"
                    f" -> Result<{names['model']}, DomainError> {{"
                )
            else:
                signature = f"pub fn {names['read']}(row: &{names['source']}) -> {names['model']} {{"
            article = _article(plan["model"]).split(" ")[0].lower()
            functions.append(
                [
                    f"/// A row of the {info['name']} table as {article} {plan['model']}.",
                    *(["#[allow(unreachable_code)]"] if pending else []),
                    signature,
                    *(f"    {line}" for line in body["lines"]),
                    *_wrapped(uow, literal),
                    "}",
                ]
            )
    blocks = [*functions, *(_HELPERS[name] for name in ("pair", "part", "rest") if name in helpers)]
    module = conversions_module(context, info)
    body_lines = [line for index, block in enumerate(blocks) for line in ([""] if index > 0 else []) + block]
    doc = f'Conversions between the application models and the "{info["name"]}" table: what the service takes and returns.'
    return rs_file(file_of(module), uses.write(), body_lines, [doc])


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def _external(context: dict, path: str) -> str:
    """A path of the crate, as the tests name it: `crate::errors` → `data_access::errors`."""
    return re.sub(r"^crate::", f"{context['crate']}::", path)


def conversion_test_file(context: dict, plans: list[dict], schema: dict, can_make) -> dict | None:
    """The tests of the conversions (tests/data/conversions.rs): a row stored by the factories is read as the model,
    and a model that goes both ways and leaves nothing to the user is written back, giving every value of the row
    (lookups and Mapper's lossless transformations included)."""
    uses = RsUses().add("super::factories")
    memory = context["settings"]["memoryRepositories"]
    if memory:
        uses.add(f"{context['crate']}::unit_of_work::MemoryUnitOfWork")
    else:
        uses.add("super::database")
    tests: list[list[str]] = []
    readers: dict[str, list[str]] = {}
    for plan in plans:
        info = find_info(context, plan["table"])
        if (
            not info
            or plan["read"] is None
            or _has_todo(plan["read"])
            or not can_make(info)
            or not any(item["name"] == plan["model"] for item in schema["models"])
        ):
            continue
        names = conversion_names(context, plan)
        dtos = _uses_dtos(context, info)
        writes = plan["write"] is not None and not _has_todo(plan["write"])
        module = _external(context, conversions_module(context, info))
        uses.add(f"{module}::{names['read']}")
        if writes:
            uses.add(f"{module}::{names['write']}")
        reader = f"{snake_name(names['source'])}_of"
        if dtos and info["name"] not in readers:
            uses.add(
                _external(context, path_in(module_of(context, info, "dtos"), names["source"])),
                _external(context, path_in(module_of(context, info, "entity"), info["entity"])),
            )
            readers[info["name"]] = [
                "/// The row as the service returns it.",
                f"fn {reader}(entity: &{info['entity']}) -> {names['source']} {{",
                f"    {names['source']} {{",
                *(
                    f"        {column['field']}: {stored('entity.' + column['field'], column)},"
                    for column in read_columns(info)
                ),
                "    }",
                "}",
            ]

        def call(is_async: bool, method: str, argument: str) -> str:
            return f'{method}({argument}, &uow).await.expect("a conversion")' if is_async else f"{method}({argument})"

        row = f"&{reader}(&row)" if dtos else "&row"
        body = [
            "let uow = MemoryUnitOfWork::default();" if memory else "let (_turn, uow) = database::open().await;",
            f"let row = factories::add_{re.sub(r'^r#', '', info['module'])}(&uow, 1).await;",
            f"let model = {call(_reads_rows(plan['read']), names['read'], row)};",
        ]
        if writes:
            body.append(f"let values = {call(_reads_rows(plan['write']), names['write'], '&model')};")
            for item in plan["write"]:
                field = column_of(info, item["column"])["field"]
                body.append(f"assert_eq!(row.{field}, values.{field});")
        else:
            body.append("let _ = model;")
        model_name = snake_name(plan["model"])
        method = f"reads_{model_name}_and_writes_it_back" if writes else f"reads_{model_name}"
        tests.append(["#[tokio::test]", f"async fn {method}() {{", *(f"    {line}" for line in body), "}"])
    if not tests:
        return None
    blocks = [*tests, *readers.values()]
    body_lines = [line for index, block in enumerate(blocks) for line in ([""] if index > 0 else []) + block]
    return rs_file(
        "tests/data/conversions.rs",
        uses.write(),
        body_lines,
        ["The conversions between the application models and the tables."],
    )


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion modules of a project and, when they are copied, the module of the models."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    return [*files, models_file(context, schema, plans)]
