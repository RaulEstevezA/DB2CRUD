"""The conversions between the application models and the tables (conversions/plan.py), written in Swift: per table,
an enum of static functions, one that turns a model into what the service takes (its create DTO, or the entity) and
one that turns what it returns into the model (`async throws` when it reads other rows). Values are converted between
the model's Swift types and the column's (numbers, decimals, text, dates, optionals, enums by a `switch`), so the
package builds without warnings; lookups go through the repositories of the unit of work; Mapper's transformations are
plain expressions; what the plan leaves to the user is a `// TODO:` with the reason, or a `fatalError` with it where a
value is needed. Mirrors web/src/core/generators/swift/conversions.ts.

The models are in a target of their own, `ApplicationModels` (the last part of `settings.modelsModule`), so their
names never clash with the entities': copied into `Sources/ApplicationModels/`, or, with `modelsSource: import`, into
`application-models/`, the target that stands for the user's module while the project runs on its own (replace it
with yours inside the application)."""

import re

from ...conversions.plan import without_hidden
from ...js import js_string
from .context import column_of, file_of, find_info, query, query_name, stored, sw_file
from .dtos import create_dto, read_columns, read_dto
from .swift import imports, member_name, sw_string, type_name

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they stand for the user's module."""


def models_target(context: dict) -> str:
    """The module of the application models: `app.application_models` → `ApplicationModels`."""
    return type_name(context["settings"]["modelsModule"].split(".")[-1])


def models_path(context: dict) -> str:
    """Where the target of the models is: in Sources/ when they are copied, in application-models/ when imported."""
    if context["settings"]["modelsSource"] == "copy":
        return f"Sources/{models_target(context)}"
    return MODELS_FOLDER


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


def conversions_type(info: dict) -> str:
    return f"{info['entity']}Conversions"


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its functions, the types they take and return, and how the model is written (by its
    module when it is named like the entity or a DTO)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    clash = plan["model"] in (info["entity"], target, source)
    named = f"{plan['model']}Model" if clash else plan["model"]
    return {
        "write": f"{_lower_first(named)}To{target}",
        "read": f"{_lower_first(source)}To{named}",
        "target": target,
        "source": source,
        "model": f"{models_target(context)}.{plan['model']}" if clash else plan["model"],
    }


# Types of the models


def _from_swift(model: dict) -> bool:
    """A model read from Swift keeps its names and types; the others get Swift's."""
    return any(field.get("originalType") is not None for field in model["fields"])


def _member_of(model: dict | None, name: str) -> str:
    return name if model is not None and _from_swift(model) else member_name(name)


_PRIMITIVE_SW = {
    "string": "String",
    "integer": "Int",
    "decimal": "Decimal",
    "boolean": "Bool",
    "date": "Date",
    "datetime": "Date",
    "time": "String",
    "duration": "Double",
    "uuid": "UUID",
    "binary": "Data",
    "any": "String",
}


def _type_ref_sw(type_ref: dict) -> str:
    """The Swift type of a model's TypeRef, for models not read from Swift."""
    kind = type_ref["kind"]
    if kind == "primitive":
        if type_ref["name"] == "float":
            return "Float" if type_ref.get("bits") == 32 else "Double"
        return _PRIMITIVE_SW[type_ref["name"]]
    if kind == "array":
        return f"[{_type_ref_sw(type_ref['items'])}]"
    if kind == "map":
        return f"[String: {_type_ref_sw(type_ref['value'])}]"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "String"


def _field_sw(model: dict | None, field: dict) -> str:
    """The Swift type of a field, as the model has it (`?` when it may be nil)."""
    if model is not None and _from_swift(model) and field.get("originalType"):
        return re.sub(r"\s+", " ", field["originalType"]).strip()
    type_text = _type_ref_sw(field["type"])
    return f"{type_text}?" if field.get("nullable") or field.get("optional") else type_text


def _enum_case(item: dict, value: dict) -> str:
    """The case of an enum value in Swift."""
    if all(re.match(r"^[a-z][A-Za-z0-9]*$", other["name"]) for other in item["values"]):
        return value["name"]
    return member_name(value["name"]).replace("`", "")


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


def model_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The copy of the application models the conversions use: public types, one per file, in their own target."""
    models, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    folder = models_path(context)
    files = [
        sw_file(
            f"{folder}/{item['name']}.swift",
            "",
            [
                f"/// {item['name']}, as the application has it.",
                f"public enum {item['name']}: String, Sendable, Equatable {{",
                *(f"    case {_enum_case(item, value)} = {sw_string(_enum_text(value))}" for value in item["values"]),
                "}",
            ],
        )
        for item in enums
    ]
    for model in models:
        fields = [
            {"name": _member_of(model, field["name"]), "type": _field_sw(model, field)} for field in model["fields"]
        ]
        params = ", ".join(
            f"{field['name']}: {field['type']}{' = nil' if field['type'].endswith('?') else ''}" for field in fields
        )
        files.append(
            sw_file(
                f"{folder}/{model['name']}.swift",
                imports("Foundation"),
                [
                    f"/// {model['name']}, as the application has it.",
                    f"public struct {model['name']}: Sendable, Equatable {{",
                    *(f"    public var {field['name']}: {field['type']}" for field in fields),
                    "",
                    f"    public init({params}) {{",
                    *(f"        self.{field['name']} = {field['name']}" for field in fields),
                    "    }",
                    "}",
                ],
            )
        )
    return files


# Values


def _typed(expression: str, type_text: str, optional: bool = False) -> dict:
    return {
        "expression": expression,
        "type": re.sub(r"\?$", "", type_text),
        "optional": optional or type_text.endswith("?"),
    }


_INTEGERS = {"Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32", "UInt64"}
_FLOATS = {"Double", "Float"}


def _is_number(type_text: str) -> bool:
    return type_text in _INTEGERS or type_text in _FLOATS


def _core(models: dict, expression: str, source: str, target: str) -> str | None:
    """A value that is there, of one Swift type, as another; None when DB2CRUD does not convert them."""
    if source == target:
        return expression
    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == target), None)
    if from_enum and target == "String":
        cases = "; ".join(
            f"case .{_enum_case(from_enum, item)}: return {sw_string(_enum_text(item))}" for item in from_enum["values"]
        )
        return f"{{ () -> String in switch {expression} {{ {cases} }} }}()"
    if to_enum and source == "String":
        cases = "; ".join(
            f"case {sw_string(_enum_text(item))}: return .{_enum_case(to_enum, item)}" for item in to_enum["values"]
        )
        return (
            f"{{ () -> {target} in switch {expression} {{ {cases}; "
            f'default: fatalError("No {target} for this value") }} }}()'
        )
    if _is_number(source) and _is_number(target):
        return f"{target}({expression})"
    if _is_number(source) and target == "Decimal":
        return f"Decimal({expression})" if source in _INTEGERS else f"Decimal(Double({expression}))"
    if source == "Decimal" and _is_number(target):
        return f"{target}(NSDecimalNumber(decimal: {expression}).doubleValue)"
    if target == "String":
        if source == "Date":
            return f"ISO8601DateFormatter().string(from: {expression})"
        if source == "UUID":
            return f"{expression}.uuidString"
        return f"String(describing: {expression})"
    if source == "String":
        if _is_number(target) or target == "Bool":
            return f"{target}({expression})!"
        if target == "Decimal":
            return f"Decimal(string: {expression})!"
        if target == "UUID":
            return f"UUID(uuidString: {expression})!"
        if target == "Date":
            return f"ISO8601DateFormatter().date(from: {expression})!"
    return None


def _simple(expression: str) -> bool:
    """Whether an expression takes a member without parentheses."""
    return re.match(r"^[\w.$]+$", expression) is not None


def _convert(models: dict, value: dict, to: str) -> str | None:
    """A value as another Swift type (`?` when it may be nil), or None when DB2CRUD does not convert them. A nil value
    stays nil when the target takes it, and is taken as there (`!`) when it does not."""
    target = re.sub(r"\?$", "", to)
    optional_target = to.endswith("?")
    expression = value["expression"]
    if not value["optional"]:
        return _core(models, expression, value["type"], target)
    if not optional_target:
        unwrapped = f"{expression}!" if _simple(expression) else f"({expression})!"
        return _core(models, unwrapped, value["type"], target)
    converted = _core(models, "$0", value["type"], target)
    if converted is None:
        return None
    if converted == "$0":
        return expression
    return f"{expression if _simple(expression) else f'({expression})'}.map {{ {converted} }}"


def _literal(value) -> dict:
    """A Swift literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("nil", "String", True)
    if isinstance(value, str):
        return _typed(sw_string(value), "String")
    if isinstance(value, bool):
        return _typed("true" if value else "false", "Bool")
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer()):
        return _typed(str(int(value)), "Int")
    return _typed(js_string(value), "Double")


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
    return f"String(describing: {value['expression']})" if converted is None else converted


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(_text(models, item) for item in values)
        return _typed(f"[{parts}].joined(separator: {sw_string(transform['separator'])})", "String")
    if kind == "split":
        separator = sw_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"rest({_text(models, value)}, {separator})", "String")
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"part({_text(models, value)}, {separator}, {part})", "String")
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        items = ", ".join(sw_string(item) for item in transform["trueValues"])
        return _typed(f"[{items}].contains({_text(models, value)})", "Bool")
    if kind == "enum":
        body["helpers"].add("pair")
        pairs = ", ".join(f"{sw_string(pair['from'])}: {sw_string(pair['to'])}" for pair in transform["pairs"])
        fallback = sw_string(transform["fallback"]) if transform.get("fallback") is not None else "nil"
        return _typed(f"pair([{pairs}], {_text(models, value)}, {fallback})", "String")
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        plain = re.sub(r"\?$", "", target)
        # From a date and time: a number; from a number: a date and time
        if _is_number(plain) or plain == "String":
            moment = _convert(models, value, "Date")
            if moment is None:
                return None
            return _typed(f"Int({moment}.timeIntervalSince1970{' * 1000' if milliseconds else ''})", "Int")
        number = _convert(models, value, "Double")
        if number is None:
            return None
        return _typed(f"Date(timeIntervalSince1970: {number}{' / 1000' if milliseconds else ''})", "Date")
    if kind == "arithmetic":
        number = _convert(models, value, "Double")
        if number is None:
            return None
        operand = _literal(transform["operand"])["expression"]
        whole = isinstance(transform["operand"], int) or (
            isinstance(transform["operand"], float) and transform["operand"].is_integer()
        )
        return _typed(f"({number} {transform['operator']} {f'{operand}.0' if whole else operand})", "Double")
    return None


def _fit(models: dict, result: dict, to: str) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, then converted."""
    if re.sub(r"\?$", "", to) in _INTEGERS and result["type"] in _FLOATS:
        return _convert(models, {**result, "expression": f"{result['expression']}.rounded()"}, to)
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
        if current is None or field is None:
            return None
        optional = result["optional"] if result else False
        expression = f"{expression}{'?' if optional else ''}.{_member_of(current, field['name'])}"
        result = _typed(expression, _field_sw(current, field), optional)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return result


def _column_typed(column: dict, root: str, entity: bool) -> dict:
    """How a column is read: from a DTO as it is, from an entity as its optional."""
    return _typed(f"{root}.{column['prop']}", column["sw"], entity or column["column"]["nullable"])


def _write_expression(context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": None, "todo": f"{_WHY['unsupported']} ({detail})"}

    def source(path: list[str]) -> dict | None:
        return _walk(models, model, path, "model")

    def finish(result: dict | None) -> dict:
        # DTOs and entities take every value as an optional
        if result is None:
            return unsupported(column["key"])
        converted = _fit(models, result, f"{column['sw']}?")
        if converted is None:
            return unsupported(f"{result['type']} to {column['sw']}")
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
        argument = _convert(models, given, by["sw"])
        if argument is None:
            return unsupported(f"{given['type']} to {by['sw']}")
        name = member_name(other["entity"])
        body["lines"] += [
            f"guard let {name} = try await uow.{other['attr']}.{query_name(context, finder)}({argument}) else {{",
            f'    throw DomainError.notFound(entity: {sw_string(other["entity"])}, key: "\\({given["expression"]})")',
            "}",
        ]
        return finish(_column_typed(column_of(other, value["key"]), name, True))
    if kind == "mapper":
        sources = [source(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["key"])
        return finish(_transformed(models, value["transform"], sources, column["sw"], body))
    given = source(value["path"])
    return finish(given and _transformed(models, _inverse(value["transform"]), [given], column["sw"], body))


def _read_expression(
    context: dict, models: dict, info: dict, dtos: bool, model: dict, field: dict, value: dict, body: dict
) -> dict:
    target = _field_sw(model, field)

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
        name = member_name(other["entity"])
        key = own(value["column"])
        nullable = column_of(info, value["column"])["column"]["nullable"]
        call = f"try await uow.{other['attr']}.{query_name(context, finder)}"
        if nullable:
            body["lines"] += [
                f"var {name}: {other['entity']}? = nil",
                f"if let key = {key['expression']} {{",
                f"    {name} = {call}(key)",
                "}",
            ]
        else:
            argument = _convert(models, key, column_of(info, value["column"])["sw"])
            body["lines"].append(f"let {name} = {call}({argument})")
        by = column_of(other, value["by"])
        return finish(_typed(f"{name}?.{by['prop']}", by["sw"], True))
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": None, "todo": "no repository query reads it"}
        item = _column_typed(column_of(other, value["value"]), "$0", True)
        found = re.match(r"^\[(.+)\]$", target)
        element = found.group(1) if found else item["type"]
        converted = _convert(models, item, element)
        if converted is None:
            return unsupported(f"{item['type']} to {element}")
        key = _convert(models, own(value["key"]), column_of(info, value["key"])["sw"])
        return {
            "expression": f"try await uow.{other['attr']}.{query_name(context, lister)}({key}).map {{ {converted} }}"
        }
    if kind == "mapper":
        return finish(_transformed(models, value["transform"], [own(name) for name in value["columns"]], target, body))
    return finish(_transformed(models, _inverse(value["transform"]), [own(value["column"])], target, body))


_HELPERS = {
    "pair": [
        "/// The value an enum pair gives, or the fallback; a value without a pair is an error.",
        "private static func pair(_ pairs: [String: String], _ value: String, _ fallback: String?) -> String {",
        '    guard let found = pairs[value] ?? fallback else { fatalError("No pair for \\(value)") }',
        "    return found",
        "}",
    ],
    "part": [
        "/// One part of a text split by a separator (the last one for -1), or an empty text.",
        "private static func part(_ value: String, _ separator: String, _ index: Int) -> String {",
        "    let parts = value.components(separatedBy: separator)",
        "    let at = index < 0 ? parts.count - 1 : index",
        '    return at < parts.count ? parts[at] : ""',
        "}",
    ],
    "rest": [
        "/// What follows the first separator of a text, or an empty text.",
        "private static func rest(_ value: String, _ separator: String) -> String {",
        '    guard let range = value.range(of: separator) else { return "" }',
        "    return String(value[range.upperBound...])",
        "}",
    ],
}


def _comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def _reads_rows(items: list[dict] | None) -> bool:
    """Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work."""
    return any(item["value"]["kind"] in ("lookup", "children") for item in items or [])


def _argument_lines(values: list[dict], indent: str) -> list[str]:
    """The arguments of an initializer, one per line, without a comma after the last; comments on lines of their
    own."""
    given = [value for value in values if value["expression"] is not None]
    result = []
    for value in values:
        if value["expression"] is None:
            result.append(f"{indent}//{_comment(value)[3:]}")
            continue
        comma = "" if given and given[-1] is value else ","
        result.append(f"{indent}{value['name']}: {value['expression']}{comma}{_comment(value)}")
    return result


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The file of the conversions of one table: one function per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    models = {"schema": schema, "target": models_target(context)}
    helpers: set[str] = set()
    functions: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        if plan["write"] is not None:
            body = {"lines": [], "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["prop"], "expression": None, "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body)
                    values.append({"name": column["prop"], **written})
            if _reads_rows(plan["write"]):
                signature = (
                    f"public static func {names['write']}(_ model: {names['model']}, uow: any UnitOfWork)"
                    f" async throws -> {names['target']} {{"
                )
            else:
                signature = f"public static func {names['write']}(_ model: {names['model']}) -> {names['target']} {{"
            functions.append(
                [
                    f"/// {_article(plan['model'])} as the {info['name']} table takes it.",
                    signature,
                    *(f"    {line}" for line in body["lines"]),
                    # The values left out take their default, nil
                    f"    return {names['target']}(",
                    *_argument_lines(values, "        "),
                    "    )",
                    "}",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = _member_of(model, field["name"])
                type_text = _field_sw(model, field)
                if item is None:
                    value = (
                        {"name": name, "expression": "nil"}
                        if type_text.endswith("?")
                        else {"name": name, "expression": None, "todo": "no column gives it"}
                    )
                elif item["value"]["kind"] == "todo":
                    value = {"name": name, "expression": None, "todo": _todo_text(item["value"])}
                else:
                    read = _read_expression(context, models, info, dtos, model, field, item["value"], body)
                    value = {"name": name, **read}
                # A value left to the user stops the program with the reason, should it run
                if value["expression"] is None:
                    reason = sw_string(f"{name}: {value['todo']}")
                    value = {"name": name, "expression": f"{{ () -> {type_text} in fatalError({reason}) }}()"}
                values.append(value)
            if _reads_rows(plan["read"]):
                signature = (
                    f"public static func {names['read']}(_ row: {names['source']}, uow: any UnitOfWork)"
                    f" async throws -> {names['model']} {{"
                )
            else:
                signature = f"public static func {names['read']}(_ row: {names['source']}) -> {names['model']} {{"
            article = _article(plan["model"]).split(" ")[0].lower()
            functions.append(
                [
                    f"/// A row of the {info['name']} table as {article} {plan['model']}.",
                    signature,
                    *(f"    {line}" for line in body["lines"]),
                    f"    return {names['model']}(",
                    *_argument_lines(values, "        "),
                    "    )",
                    "}",
                ]
            )
    blocks = [*functions, *(_HELPERS[name] for name in ("pair", "part", "rest") if name in helpers)]
    name = conversions_type(info)
    body_lines = [
        f'/// Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        " returns.",
        f"public enum {name} {{",
    ]
    for index, block in enumerate(blocks):
        if index > 0:
            body_lines.append("")
        body_lines += [f"    {line}" if line else "" for line in block]
    body_lines.append("}")
    return sw_file(file_of(context, info, "service", name), imports("Foundation", models["target"]), body_lines)


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def conversion_test_file(context: dict, plans: list[dict], schema: dict, can_make) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    memory = context["settings"]["memoryRepositories"]
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
        type_text = conversions_type(info)
        reader = f"{_lower_first(names['source'])}Of"
        if dtos and info["name"] not in readers:
            arguments = ", ".join(
                f"{column['prop']}: {stored('entity.' + column['prop'], column)}" for column in read_columns(info)
            )
            readers[info["name"]] = [
                # By its module: Swift Testing has types of its own, such as Tag
                "/// The row as the service returns it.",
                f"fileprivate func {reader}(_ entity: {context['module']}.{info['entity']})"
                f" -> {context['module']}.{names['source']} {{",
                f"    {names['source']}({arguments})",
                "}",
            ]

        def call(is_async: bool, method: str, argument: str, type_text: str = type_text) -> str:
            return (
                f"try await {type_text}.{method}({argument}, uow: uow)"
                if is_async
                else f"{type_text}.{method}({argument})"
            )

        row = f"{reader}(row)" if dtos else "row"
        body = [
            f"let row = try await Factories.add{info['entity']}(uow, 1)",
            f"let model = {call(_reads_rows(plan['read']), names['read'], row)}",
        ]
        if writes:
            body.append(f"let values = {call(_reads_rows(plan['write']), names['write'], 'model')}")
            for item in plan["write"]:
                prop = column_of(info, item["column"])["prop"]
                body.append(f"#expect(values.{prop} == row.{prop})")
        else:
            body.append("_ = model")
        method = f"reads{plan['model']}AndWritesItBack" if writes else f"reads{plan['model']}"
        if memory:
            inner = ["    let uow = MemoryUnitOfWork()", *(f"    {line}" for line in body)]
        else:
            inner = ["    try await TestDatabase.with { uow in", *(f"        {line}" for line in body), "    }"]
        tests.append([f"@Test func {method}() async throws {{", *inner, "}"])
    if not tests:
        return None
    header = "\n".join(["import Foundation", "import Testing", f"@testable import {context['module']}"])
    return sw_file(
        f"Tests/{context['module']}Tests/ConversionTests.swift",
        header,
        [
            "extension DataTests {",
            "    /// The conversions between the application models and the tables.",
            "    @Suite struct ConversionTests {",
            *[line for test in tests for line in ("", *(f"        {item}" for item in test))],
            "    }",
            "}",
            *[line for reader in readers.values() for line in ("", *reader)],
        ],
    )


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion files of a project and the copy of the models they use."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    return [*files, *model_files(context, schema, plans)]
