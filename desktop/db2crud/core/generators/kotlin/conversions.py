"""The conversions between the application models and the tables (conversions/plan.py), written in Kotlin: per table,
an object with one function that turns a model into what the service takes (its create DTO, or the entity) and one
that turns what it returns into the model. Values are converted between the model's Kotlin types and the column's
(numbers of another size, text, dates and times, nullable values, enums by a `when`), so the project compiles;
lookups go through the repositories of the unit of work; Mapper's transformations are plain expressions; what the
plan leaves to the user is a `// TODO:` with the reason, or Kotlin's `TODO()` where a value is needed. Mirrors
web/src/core/generators/kotlin/conversions.ts.

Models are built as the application has them: a constructor with named arguments, or `apply` on a class whose
properties are set one by one. They are copied into the project (`settings.modelsModule` as their package) or, with
`modelsSource: import`, used from the user's package: the copy then goes to `application-models/`, a source folder
the build adds while it exists (delete it inside the application)."""

import re

from ...conversions.plan import has_todo, lossy, without_hidden
from ...js import js_string
from ...matching.names import fields_of
from .context import (
    column_of,
    errors_package,
    find_info,
    kt_file,
    package_of,
    path_of,
    qualified,
    query,
    query_name,
    stored,
)
from .dtos import create_dto, read_columns, read_dto
from .kotlin import KtImports, kt_string, member_name
from .tests import close_test, open_test

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they are imported from the user's package."""


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


def conversions_package(context: dict, info: dict) -> str:
    """The package of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}.{info['pkg']}"
    return f"{context['base']}.conversions"


def conversions_object(info: dict) -> str:
    return f"{info['entity']}Conversions"


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its functions, the classes they take and return, and the name the model is used by (an
    import alias, `ProductModel`, when it is named like the entity or a DTO of the same file)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    clash = plan["model"] in (info["entity"], target, source)
    model = f"{plan['model']}Model" if clash else plan["model"]
    return {
        "write": f"{_lower_first(model)}To{target}",
        "read": f"{_lower_first(source)}To{model}",
        "target": target,
        "source": source,
        "model": model,
        "clash": clash,
    }


# Types of the models

_KNOWN = {
    "BigDecimal": "java.math.BigDecimal",
    "BigInteger": "java.math.BigInteger",
    "LocalDate": "java.time.LocalDate",
    "LocalDateTime": "java.time.LocalDateTime",
    "LocalTime": "java.time.LocalTime",
    "OffsetDateTime": "java.time.OffsetDateTime",
    "OffsetTime": "java.time.OffsetTime",
    "Instant": "java.time.Instant",
    "ZonedDateTime": "java.time.ZonedDateTime",
    "Duration": "java.time.Duration",
    "UUID": "java.util.UUID",
}


def _from_kotlin(model: dict) -> bool:
    """A model read from Kotlin keeps its names and types; the others get Kotlin's."""
    return any(field.get("originalType") is not None for field in model["fields"])


def _member_of(model: dict | None, name: str) -> str:
    return name if model is not None and _from_kotlin(model) else member_name(name)


_PRIMITIVE_KT = {
    "string": "String",
    "decimal": "BigDecimal",
    "boolean": "Boolean",
    "date": "LocalDate",
    "datetime": "OffsetDateTime",
    "time": "LocalTime",
    "duration": "Duration",
    "uuid": "UUID",
    "binary": "ByteArray",
    "any": "Any",
}


def _type_ref_kt(type_ref: dict) -> str:
    """The Kotlin type of a model's TypeRef, for models not read from Kotlin."""
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        bits = type_ref.get("bits")
        if name == "integer":
            return "Int" if bits in (8, 16, 32) else "Long"
        if name == "float":
            return "Float" if bits == 32 else "Double"
        return _PRIMITIVE_KT[name]
    if kind == "array":
        return f"List<{_type_ref_kt(type_ref['items'])}>"
    if kind == "map":
        return f"Map<String, {_type_ref_kt(type_ref['value'])}>"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "Any"


def _simple(type_text: str) -> str:
    """`java.time.LocalDate` → `LocalDate`, in every part of a type."""
    return re.sub(r"\b(?:[a-z_]\w*\.)+(?=[A-Z])", "", type_text)


def _field_kt(model: dict | None, field: dict) -> str:
    """The Kotlin type of a field, as the model has it (with `?` when it may be null)."""
    if model is not None and _from_kotlin(model) and field.get("originalType"):
        return _simple(field["originalType"].strip())
    type_text = _type_ref_kt(field["type"])
    return f"{type_text}?" if field.get("nullable") or field.get("optional") else type_text


def _enum_constant(item: dict, value: dict) -> str:
    """The constant of an enum value in Kotlin."""
    if all(re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", other["name"]) for other in item["values"]):
        return value["name"]
    return re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", member_name(value["name"]).replace("`", "")).upper()


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


def _imports_of_types(imports: KtImports, types: list[str]) -> None:
    for type_text in types:
        for word in re.findall(r"\b[A-Z]\w*", type_text):
            if word in _KNOWN:
                imports.add(_KNOWN[word])


_ZERO = {
    "Int": "0",
    "Long": "0L",
    "Short": "0",
    "Double": "0.0",
    "Float": "0f",
    "Boolean": "false",
    "String": '""',
    "BigDecimal": "BigDecimal.ZERO",
}


def _initial(models: dict, type_text: str) -> str | None:
    """The value a property of a copied class starts with."""
    if type_text.endswith("?"):
        return "null"
    if type_text in _ZERO:
        return _ZERO[type_text]
    if type_text.startswith("List<"):
        return "emptyList()"
    if type_text.startswith("Map<"):
        return "emptyMap()"
    item = next((candidate for candidate in models["schema"]["enums"] if candidate["name"] == type_text), None)
    if item:
        return f"{type_text}.{_enum_constant(item, item['values'][0])}"
    return None


def _model_class(models: dict, model: dict) -> list[str]:
    """The class of a copied model, as the application has it."""
    fields = [{"type": _field_kt(model, field), "name": _member_of(model, field["name"])} for field in model["fields"]]
    doc = f"/** {model['name']}, as the application has it. */"
    if model.get("construction") != "properties":
        return [
            doc,
            f"data class {model['name']}(",
            *(
                f"    val {field['name']}: {field['type']}{' = null' if field['type'].endswith('?') else ''},"
                for field in fields
            ),
            ")",
        ]
    members = []
    for field in fields:
        value = _initial(models, field["type"])
        if value is None:
            members.append(f"    lateinit var {field['name']}: {field['type']}")
        else:
            members.append(f"    var {field['name']}: {field['type']} = {value}")
    return [doc, f"class {model['name']} {{", *members, "}"]


def model_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The copy of the application models the conversions use: a class or enum per file."""
    models = {"schema": schema, "pkg": context["settings"]["modelsModule"]}
    pkg = models["pkg"]
    folder = "" if context["settings"]["modelsSource"] == "copy" else f"{MODELS_FOLDER}/"
    classes, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    files = [
        kt_file(
            f"{folder}{path_of(pkg, item['name'])}",
            pkg,
            "",
            [
                f"/** {item['name']}, as the application has it. */",
                f"enum class {item['name']} {{",
                *(f"    {_enum_constant(item, value)}," for value in item["values"]),
                "}",
            ],
        )
        for item in enums
    ]
    for model in classes:
        imports = KtImports(pkg)
        _imports_of_types(imports, [_field_kt(model, field) for field in model["fields"]])
        files.append(
            kt_file(f"{folder}{path_of(pkg, model['name'])}", pkg, imports.write(), _model_class(models, model))
        )
    return files


# Values


def _typed(expression: str, type_text: str, nullable: bool = False) -> dict:
    return {
        "expression": expression,
        "type": re.sub(r"\?$", "", type_text),
        "nullable": nullable or type_text.endswith("?"),
    }


_NUMBERS = {"Byte", "Short", "Int", "Long", "Float", "Double", "BigDecimal", "BigInteger"}
_TEMPORAL = {"LocalDate", "LocalDateTime", "LocalTime", "OffsetDateTime", "OffsetTime", "Instant", "ZonedDateTime"}


def _sure(expression: str) -> str:
    """`x!!`, with parentheses when the expression ends a chain of safe calls."""
    return f"({expression})!!" if re.search(r"\?\.|\?:| ", expression) else f"{expression}!!"


_LIST = re.compile(r"^(?:List|MutableList|Set|MutableSet|Collection)<(.+)>$")


def _collect(type_text: str) -> str:
    """`.toSet()`, when a list must become another collection."""
    if type_text.startswith("Set<"):
        return ".toSet()"
    found = re.match(r"^Mutable(?:List|Set)(?=<)", type_text)
    return f".to{found.group(0)}()" if found else ""


def _core_document(models: dict, expression: str, source: str, target: str) -> tuple[bool, str | None]:
    """What a document database keeps in its own way: whether it is one of these values, and how it is converted."""
    imports = models.get("imports")
    if {source, target} == {"LocalDate", "Instant"} and imports is not None:
        imports.add("java.time.ZoneOffset")
    if source == "LocalDate" and target == "Instant":
        return True, f"{expression}.atStartOfDay(ZoneOffset.UTC).toInstant()"
    if source == "Instant" and target == "LocalDate":
        return True, f"{expression}.atOffset(ZoneOffset.UTC).toLocalDate()"
    if source == "Any":
        return True, None
    from_item, to_item = _LIST.match(source), _LIST.match(target)
    if not from_item or not to_item:
        return False, None
    converted = _convert(models, _typed("item", from_item.group(1)), to_item.group(1))
    if converted is None:
        return True, None
    if converted == "item":
        as_list = "" if source.startswith(("List<", "Mutable")) else ".toList()"
        return True, f"{expression}{_collect(target) or as_list}"
    return True, f"{expression}.map {{ item -> {converted} }}{_collect(target)}"


def _core(models: dict, expression: str, source: str, target: str) -> str | None:
    """A value that is there, of one Kotlin type, as another; None when DB2CRUD does not convert them."""
    if source == target or target == "Any":
        return expression
    imports = models.get("imports")
    if models.get("documents"):
        own, converted = _core_document(models, expression, source, target)
        if own:
            return converted

    def utc() -> str:
        if imports is not None:
            imports.add("java.time.ZoneOffset")
        return "ZoneOffset.UTC"

    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == target), None)
    for item in (from_enum, to_enum):
        if item and imports is not None:
            imports.add(f"{models['pkg']}.{item['name']}")
    if from_enum and target == "String":
        cases = "; ".join(
            f"{source}.{_enum_constant(from_enum, item)} -> {kt_string(_enum_text(item))}"
            for item in from_enum["values"]
        )
        return f"when ({expression}) {{ {cases} }}"
    if to_enum and source == "String":
        cases = "; ".join(
            f"{kt_string(_enum_text(item))} -> {target}.{_enum_constant(to_enum, item)}" for item in to_enum["values"]
        )
        return (
            f'when ({expression}) {{ {cases}; else -> throw IllegalArgumentException("No {target} for this value") }}'
        )
    if source in _NUMBERS and target in _NUMBERS:
        if target == "BigDecimal":
            return f"{expression}.toBigDecimal()"
        if target == "BigInteger":
            if source == "BigDecimal":
                return f"{expression}.toBigInteger()"
            return f"{expression}.toLong().toBigInteger()"
        if target in ("Short", "Byte"):
            return f"{expression}.toInt().to{target}()"
        return f"{expression}.to{target}()"
    if target == "String":
        return f"{expression}.toPlainString()" if source == "BigDecimal" else f"{expression}.toString()"
    if source == "String":
        if target in ("Int", "Long", "Short", "Byte", "Float", "Double", "Boolean", "BigDecimal", "BigInteger"):
            return f"{expression}.to{target}()"
        if target == "UUID":
            if imports is not None:
                imports.add("java.util.UUID")
            return f"UUID.fromString({expression})"
        if target in _TEMPORAL:
            if imports is not None:
                imports.add(_KNOWN[target])
            return f"{target}.parse({expression})"
        return None
    pairs = {
        "OffsetDateTime>LocalDateTime": lambda: f"{expression}.toLocalDateTime()",
        "OffsetDateTime>Instant": lambda: f"{expression}.toInstant()",
        "OffsetDateTime>LocalDate": lambda: f"{expression}.toLocalDate()",
        "LocalDateTime>OffsetDateTime": lambda: f"{expression}.atOffset({utc()})",
        "LocalDateTime>Instant": lambda: f"{expression}.toInstant({utc()})",
        "LocalDateTime>LocalDate": lambda: f"{expression}.toLocalDate()",
        "LocalDate>LocalDateTime": lambda: f"{expression}.atStartOfDay()",
        "LocalDate>OffsetDateTime": lambda: f"{expression}.atStartOfDay().atOffset({utc()})",
        "Instant>OffsetDateTime": lambda: f"{expression}.atOffset({utc()})",
        "Instant>LocalDateTime": lambda: f"LocalDateTime.ofInstant({expression}, {utc()})",
    }
    pair = pairs.get(f"{source}>{target}")
    if pair is None:
        return None
    if target in _KNOWN and imports is not None:
        imports.add(_KNOWN[target])
    return pair()


def _convert(models: dict, value: dict, to: str) -> str | None:
    """A value as another Kotlin type (`?` when it may be null), or None when DB2CRUD does not convert them. A value
    that may be null stays null when the target takes null, and is taken as there (`!!`) when it does not."""
    target = re.sub(r"\?$", "", to)
    nullable_target = to.endswith("?")
    expression = value["expression"]
    if not value["nullable"]:
        return _core(models, expression, value["type"], target)
    # A list that is not there is an empty one
    if models.get("documents") and not nullable_target and _LIST.match(target):
        return _core(models, f"{expression}.orEmpty()", value["type"], target)
    if not nullable_target:
        return _core(models, _sure(expression), value["type"], target)
    converted = _core(models, "it", value["type"], target)
    if converted is None:
        return None
    return expression if converted == "it" else f"{expression}?.let {{ {converted} }}"


def _literal(value) -> dict:
    """A Kotlin literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("null", "Any", True)
    if isinstance(value, str):
        return _typed(kt_string(value), "String")
    if isinstance(value, bool):
        return _typed("true" if value else "false", "Boolean")
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer()):
        return _typed(f"{js_string(value)}L", "Long")
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
    return f"{value['expression']}.toString()" if converted is None else converted


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(_text(models, item) for item in values)
        return _typed(f"listOf({parts}).joinToString({kt_string(transform['separator'])})", "String")
    if kind == "split":
        separator = kt_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"rest({_text(models, value)}, {separator})", "String")
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"part({_text(models, value)}, {separator}, {part})", "String")
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        items = ", ".join(kt_string(item) for item in transform["trueValues"])
        return _typed(f"{_text(models, value)} in setOf({items})", "Boolean")
    if kind == "enum":
        body["helpers"].add("pair")
        pairs = ", ".join(f"{kt_string(pair['from'])} to {kt_string(pair['to'])}" for pair in transform["pairs"])
        fallback = kt_string(transform["fallback"]) if transform.get("fallback") is not None else "null"
        return _typed(f"pair(mapOf({pairs}), {_text(models, value)}, {fallback})", "String")
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        plain = re.sub(r"\?$", "", target)
        # From a date and time: a number; from a number: an instant
        if plain in _NUMBERS or plain == "String":
            moment = _convert(models, value, "Instant")
            if moment is None:
                return None
            return _typed(f"{moment}.{'toEpochMilli()' if milliseconds else 'epochSecond'}", "Long")
        number = _convert(models, value, "Long")
        if number is None:
            return None
        if models.get("imports") is not None:
            models["imports"].add("java.time.Instant")
        return _typed(f"Instant.{'ofEpochMilli' if milliseconds else 'ofEpochSecond'}({number})", "Instant")
    if kind == "arithmetic":
        number = _convert(models, value, "Double")
        if number is None:
            return None
        operand = re.sub(r"L$", ".0", _literal(transform["operand"])["expression"])
        return _typed(f"({number} {transform['operator']} {operand})", "Double")
    return None


def _fit(models: dict, result: dict, to: str) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, then converted."""
    whole = re.sub(r"\?$", "", to) in ("Byte", "Short", "Int", "Long", "BigInteger")
    if whole and result["type"] in ("Double", "Float"):
        return _convert(models, {**result, "expression": f"Math.round({result['expression']})", "type": "Long"}, to)
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
        nullable = result["nullable"] if result else False
        expression = f"{expression}{'?' if nullable else ''}.{_member_of(current, field['name'])}"
        result = _typed(expression, _field_kt(current, field), nullable)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return result


def _column_typed(column: dict, root: str, entity: bool) -> dict:
    """How a column is read: from a DTO as it is, from an entity as its nullable property."""
    return _typed(f"{root}.{column['prop']}", column["kt"], entity or column["column"]["nullable"])


# Nested documents: {"context", "models", "info", "plan", "imports", "functions"}, the functions written so far


def _nested_model(nested: dict, name: str) -> str:
    """How a nested model is written: by an alias when the entity or a DTO of the file has its name."""
    names = conversion_names(nested["context"], nested["plan"])
    clash = name in (nested["info"]["entity"], names["target"], names["source"])
    alias = f" as {name}Model" if clash else ""
    nested["imports"].add(f"{qualified(nested['models']['pkg'], name)}{alias}")
    return f"{name}Model" if clash else name


def _model_named(nested: dict, name: str) -> dict:
    schema = nested["models"]["schema"]
    model = next(item for item in schema["models"] if item["name"] == name)
    return {**model, "fields": fields_of(model, schema)}


def _import_entity(nested: dict) -> None:
    info = nested["info"]
    nested["imports"].add(qualified(package_of(nested["context"], info, "entity"), info["entity"]))


def _upper_first(text: str) -> str:
    return text[:1].upper() + text[1:].replace("`", "")


def _call_for(name: str, many: bool, value: dict, to: str) -> str:
    """A nested document, or each of a list, converted by a function; `to` is the type it becomes."""
    nullable = to.endswith("?")
    expression = value["expression"]
    if many:
        collected = _collect(to)
        if not value["nullable"]:
            return f"{expression}.map {{ {name}(it) }}{collected}"
        if not nullable:
            return f"{expression}.orEmpty().map {{ {name}(it) }}{collected}"
        return f"{expression}?.map {{ {name}(it) }}{'?' + collected if collected else ''}"
    if not value["nullable"]:
        return f"{name}({expression})"
    return f"{expression}?.let {{ {name}(it) }}" if nullable else f"{name}({_sure(expression)})"


def _named_lines(type_text: str, values: list[dict]) -> list[str]:
    """A class built with named arguments: the values left out take their default, null."""
    return [
        f"    return {type_text}(",
        *(
            _todo_line(value, "        ")
            if value["expression"] is None
            else f"        {value['name']} = {value['expression']},{_comment(value)}"
            for value in values
        ),
        "    )",
    ]


# What a property of a model could be hidden by
_PARAMETERS = {"row", "uow", "value"}


def _model_lines(type_text: str, model: dict, values: list[dict], given: set[str]) -> list[str]:
    """A model built as the application has it, from the values the plan gives."""
    if model.get("construction") == "properties":
        # Built by its properties: the fields the plan does not give keep the model's defaults
        result = [f"    return {type_text}().apply {{"]
        for value in values:
            if value["name"] not in given:
                continue
            if value["expression"] is None:
                result.append(_todo_line(value, "        "))
            else:
                own = "this." if value["name"] in _PARAMETERS else ""
                result.append(f"        {own}{value['name']} = {value['expression']}{_comment(value)}")
        return [*result, "    }"]
    # Kotlin's TODO() stands for a value left to the user, and says why when it runs
    result = [f"    return {type_text}("]
    for value in values:
        if value["expression"] is None:
            reason = kt_string(f"{value['name']}: {value['todo']}")
            result.append(f"        {value['name']} = TODO({reason}),")
        else:
            result.append(f"        {value['name']} = {value['expression']},{_comment(value)}")
    return [*result, "    )"]


def _left_out(name: str, type_text: str) -> dict:
    """The value of a field no column gives."""
    if type_text.endswith("?"):
        return {"name": name, "expression": "null"}
    return {"name": name, "expression": None, "todo": "no column gives it"}


def _write_document(nested: dict, value: dict, kept: dict, path: str) -> str:
    """Writes the function that gives a nested document from its model, and those inside it; gives its name."""
    models = nested["models"]
    name = f"{_lower_first(nested['plan']['model'])}{path}ToDocument"
    model = _model_named(nested, value["model"])
    values = []
    for item in value["values"]:
        field = next(candidate for candidate in kept["fields"] if candidate["column"]["name"] == item["column"])
        inner = item["value"]
        if inner["kind"] == "todo":
            values.append({"name": field["prop"], "expression": None, "todo": _todo_text(inner)})
            continue
        if inner["kind"] not in ("field", "document"):
            continue
        read = _walk(models, model, inner["path"], "value")
        if inner["kind"] == "document":
            function = _write_document(nested, inner, field["nested"], path + _upper_first(field["prop"]))
            call = _call_for(function, inner["many"], read, f"{field['kt']}?")
            values.append({"name": field["prop"], "expression": call})
            continue
        converted = _fit(models, read, f"{field['kt']}?")
        if converted is not None:
            values.append({"name": field["prop"], "expression": converted})
        else:
            todo = f"{_WHY['unsupported']} ({read['type']} to {field['kt']})"
            values.append({"name": field["prop"], "expression": None, "todo": todo})
    _import_entity(nested)
    unused = all(item["expression"] is None for item in values)
    nested["functions"].append(
        [
            f"/** {_article(value['model'])} as the documents of the {nested['info']['name']} collection keep it. */",
            *(['@Suppress("UNUSED_PARAMETER")'] if unused else []),
            f"private fun {name}(value: {_nested_model(nested, value['model'])}): {kept['path']} {{",
            *([f"    // Not stored: {', '.join(value['unused'])}"] if value["unused"] else []),
            *_named_lines(kept["path"], values),
            "}",
        ]
    )
    return name


def _read_document(nested: dict, value: dict, kept: dict, path: str) -> str:
    """Writes the function that gives a model from its nested document, and those inside it; gives its name."""
    models = nested["models"]
    name = f"{_lower_first(nested['plan']['model'])}{path}FromDocument"
    model = _model_named(nested, value["model"])
    given: set[str] = set()
    values = []
    for field in model["fields"]:
        item = next((candidate for candidate in value["values"] if candidate["field"] == field["name"]), None)
        prop = _member_of(model, field["name"])
        target = _field_kt(model, field)
        inner = item["value"] if item else None
        if inner is None or inner["kind"] not in ("todo", "column", "document"):
            values.append(_left_out(prop, target))
            continue
        given.add(prop)
        if inner["kind"] == "todo":
            values.append({"name": prop, "expression": None, "todo": _todo_text(inner)})
            continue
        source = next(candidate for candidate in kept["fields"] if candidate["column"]["name"] == inner["column"])
        read = _typed(f"value.{source['prop']}", source["kt"], True)
        if inner["kind"] == "document":
            function = _read_document(nested, inner, source["nested"], path + _upper_first(source["prop"]))
            values.append({"name": prop, "expression": _call_for(function, inner["many"], read, target)})
            continue
        converted = _fit(models, read, target)
        if converted is None:
            todo = f"{_WHY['unsupported']} ({source['kt']} to {target})"
            values.append({"name": prop, "expression": None, "todo": todo})
        else:
            values.append({"name": prop, "expression": converted})
    type_text = _nested_model(nested, value["model"])
    _import_entity(nested)
    article = _article(value["model"]).split(" ")[0].lower()
    nested["functions"].append(
        [
            f"/** A document of the {nested['info']['name']} collection as {article} {value['model']}. */",
            f"private fun {name}(value: {kept['path']}): {type_text} {{",
            *_model_lines(type_text, model, values, given),
            "}",
        ]
    )
    return name


def _write_expression(
    context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict, nested: dict
) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": None, "todo": f"{_WHY['unsupported']} ({detail})"}

    def source(path: list[str]) -> dict | None:
        return _walk(models, model, path, "model")

    def finish(result: dict | None) -> dict:
        # DTOs and entities take every value as nullable
        if result is None:
            return unsupported(column["prop"])
        converted = _fit(models, result, f"{column['kt']}?")
        if converted is None:
            return unsupported(f"{result['type']} to {column['kt']}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "document":
        given = source(value["path"])
        kept = nested["info"]["nested"].get(column["column"]["name"])
        if given is None or kept is None:
            return unsupported(column["prop"])
        name = _write_document(nested, value, kept, _upper_first(column["prop"]))
        return {"expression": _call_for(name, value["many"], given, f"{column['kt']}?")}
    if kind == "field":
        return finish(source(value["path"]))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        given = source(value["path"])
        if not other or not finder or not given:
            return {"expression": None, "todo": "no repository query finds the row it names"}
        by = column_of(other, value["by"])
        argument = _convert(models, given, by["kt"])
        if argument is None:
            return unsupported(f"{given['type']} to {by['kt']}")
        name = member_name(other["entity"])
        body["imports"].add(qualified(errors_package(context), "NotFoundException"))
        fallback = ' ?: ""' if given["nullable"] else ""
        body["lines"] += [
            f"val {name} = uow.{other['attr']}.{query_name(context, finder)}({argument})",
            f"    ?: throw NotFoundException({kt_string(other['entity'])}, {given['expression']}{fallback})",
        ]
        return finish(_column_typed(column_of(other, value["key"]), name, True))
    if kind == "mapper":
        sources = [source(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["prop"])
        return finish(_transformed(models, value["transform"], sources, column["kt"], body))
    given = source(value["path"])
    return finish(given and _transformed(models, _inverse(value["transform"]), [given], column["kt"], body))


def _read_expression(
    context: dict, models: dict, info: dict, dtos: bool, model: dict, field: dict, value: dict, body: dict, nested: dict
) -> dict:
    target = _field_kt(model, field)

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
    if kind == "document":
        kept = info["nested"].get(value["column"])
        if kept is None:
            return unsupported(field["name"])
        name = _read_document(nested, value, kept, _upper_first(column_of(info, value["column"])["prop"]))
        return {"expression": _call_for(name, value["many"], own(value["column"]), target)}
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
        argument = _sure(key["expression"]) if key["nullable"] and not nullable else key["expression"]
        call = f"uow.{other['attr']}.{query_name(context, finder)}"
        body["lines"].append(
            f"val {name} = {key['expression']}?.let {{ {call}(it) }}"
            if nullable
            else f"val {name} = {call}({argument})"
        )
        by = column_of(other, value["by"])
        return finish(_typed(f"{name}?.{by['prop']}", by["kt"], True))
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": None, "todo": "no repository query reads it"}
        item = _column_typed(column_of(other, value["value"]), "it", True)
        found = re.match(r"^(?:List|Set|Collection)<(.+)>\??$", target)
        element = found.group(1) if found else item["type"]
        converted = _convert(models, item, element)
        if converted is None:
            return unsupported(f"{item['type']} to {element}")
        key = own(value["key"])
        argument = _sure(key["expression"]) if key["nullable"] else key["expression"]
        rows = f"uow.{other['attr']}.{query_name(context, lister)}({argument})"
        return {"expression": f"{rows}.map {{ {converted} }}{'.toSet()' if target.startswith('Set<') else ''}"}
    if kind == "mapper":
        return finish(_transformed(models, value["transform"], [own(name) for name in value["columns"]], target, body))
    return finish(_transformed(models, _inverse(value["transform"]), [own(value["column"])], target, body))


_HELPERS = {
    "pair": [
        "/** The value an enum pair gives, or the fallback; a value without a pair is an error. */",
        "private fun pair(pairs: Map<String, String>, value: String, fallback: String?): String =",
        '    pairs[value] ?: fallback ?: throw IllegalArgumentException("No pair for $value")',
    ],
    "part": [
        "/** One part of a text split by a separator (the last one for -1), or an empty text. */",
        "private fun part(value: String, separator: String, index: Int): String {",
        "    val parts = value.split(separator)",
        '    return parts.getOrNull(if (index < 0) parts.size - 1 else index) ?: ""',
        "}",
    ],
    "rest": [
        "/** What follows the first separator of a text, or an empty text. */",
        "private fun rest(value: String, separator: String): String =",
        '    if (separator in value) value.substringAfter(separator) else ""',
    ],
}


def _comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def _todo_line(value: dict, indent: str) -> str:
    return f"{indent}//{_comment(value)[3:]}"


def _reads_rows(items: list[dict] | None) -> bool:
    """Whether a lookup or a list of the plan reads other rows, so the function takes the unit of work."""
    return any(item["value"]["kind"] in ("lookup", "children") for item in items or [])


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The object of the conversions of one table: one function per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    pkg = conversions_package(context, info)
    imports = KtImports(pkg)
    models = {"schema": schema, "pkg": context["settings"]["modelsModule"], "imports": imports}
    models["documents"] = bool(context["orm"].get("documents"))
    helpers: set[str] = set()
    functions: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        nested = {"context": context, "models": models, "info": info, "plan": plan, "imports": imports, "functions": []}
        alias = f" as {names['model']}" if names["clash"] else ""
        imports.add(f"{qualified(models['pkg'], plan['model'])}{alias}")
        if plan["write"] is not None:
            body = {"lines": [], "imports": imports, "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["prop"], "expression": None, "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body, nested)
                    values.append({"name": column["prop"], **written})
            imports.add(qualified(package_of(context, info, "dtos" if dtos else "entity"), names["target"]))
            uow = _reads_rows(plan["write"])
            if uow:
                imports.add(qualified(context["base"], "UnitOfWork"))
            params = f"model: {names['model']}{', uow: UnitOfWork' if uow else ''}"
            functions.append(
                [
                    f"/** {_article(plan['model'])} as the {info['name']} table takes it. */",
                    f"fun {names['write']}({params}): {names['target']} {{",
                    *(f"    {line}" for line in body["lines"]),
                    *_named_lines(names["target"], values),
                    "}",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "imports": imports, "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = _member_of(model, field["name"])
                if item is None:
                    values.append(_left_out(name, _field_kt(model, field)))
                elif item["value"]["kind"] == "todo":
                    values.append({"name": name, "expression": None, "todo": _todo_text(item["value"])})
                else:
                    read = _read_expression(context, models, info, dtos, model, field, item["value"], body, nested)
                    values.append({"name": name, **read})
            imports.add(qualified(package_of(context, info, "dtos" if dtos else "entity"), names["source"]))
            uow = _reads_rows(plan["read"])
            if uow:
                imports.add(qualified(context["base"], "UnitOfWork"))
            given = {_member_of(model, item["field"]) for item in plan["read"]}
            article = _article(plan["model"]).split(" ")[0].lower()
            params = f"row: {names['source']}{', uow: UnitOfWork' if uow else ''}"
            functions.append(
                [
                    f"/** A row of the {info['name']} table as {article} {plan['model']}. */",
                    f"fun {names['read']}({params}): {names['model']} {{",
                    *(f"    {line}" for line in body["lines"]),
                    *_model_lines(names["model"], model, values, given),
                    "}",
                ]
            )
        functions += nested["functions"]
    blocks = [*functions, *(_HELPERS[name] for name in ("pair", "part", "rest") if name in helpers)]
    name = conversions_object(info)
    body_lines = [
        f'/** Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        " returns. */",
        f"object {name} {{",
    ]
    for index, block in enumerate(blocks):
        if index > 0:
            body_lines.append("")
        body_lines += [f"    {line}" if line else "" for line in block]
    body_lines.append("}")
    return kt_file(path_of(pkg, name), pkg, imports.write(), body_lines)


def conversion_test_file(context: dict, plans: list[dict], schema: dict, can_make) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    pkg = context["base"]
    imports = KtImports(pkg).add(
        "kotlin.test.BeforeTest", "kotlin.test.Test", "kotlin.test.assertEquals", "kotlin.test.assertNotNull"
    )
    memory = context["settings"]["memoryRepositories"]
    if not memory and context["orm"]["closeTest"]:
        imports.add("kotlin.test.AfterTest")
    tests: list[list[str]] = []
    readers: dict[str, list[str]] = {}
    for plan in plans:
        info = find_info(context, plan["table"])
        if not info or plan["read"] is None or has_todo(plan["read"]) or not can_make(info):
            continue
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        if model is None:
            continue
        names = conversion_names(context, plan)
        dtos = _uses_dtos(context, info)
        writes = plan["write"] is not None and not has_todo(plan["write"])
        obj = conversions_object(info)
        imports.add(qualified(conversions_package(context, info), obj))
        reader = f"{_lower_first(names['source'])}Of"
        if dtos and info["name"] not in readers:
            imports.add(
                qualified(package_of(context, info, "dtos"), names["source"]),
                qualified(package_of(context, info, "entity"), info["entity"]),
            )
            readers[info["name"]] = [
                "    /** The row as the service returns it. */",
                f"    private fun {reader}(entity: {info['entity']}): {names['source']} =",
                f"        {names['source']}(",
                *(
                    f"            {column['prop']} = {stored('entity.' + column['prop'], column)},"
                    for column in read_columns(info)
                ),
                "        )",
            ]
        row = f"{reader}(row)" if dtos else "row"
        body = [
            f"val row = Factories.add{info['entity']}(uow, 1)",
            f"val model = {obj}.{names['read']}({row}{', uow' if _reads_rows(plan['read']) else ''})",
        ]
        if writes:
            body.append(f"val values = {obj}.{names['write']}(model{', uow' if _reads_rows(plan['write']) else ''})")
            for item in plan["write"]:
                column = column_of(info, item["column"])
                fields = fields_of(model, schema)
                # A value the model keeps with less detail is not written back as it was
                if context["orm"].get("documents") and lossy(item["value"], column["column"]["type"], fields, schema):
                    continue
                body.append(f"assertEquals(row.{column['prop']}, values.{column['prop']})")
        else:
            body.append("assertNotNull(model)")
        method = f"reads{plan['model']}AndWritesItBack" if writes else f"reads{plan['model']}"
        tests.append(["    @Test", f"    fun {method}() {{", *(f"        {line}" for line in body), "    }"])
    if not tests:
        return None
    return kt_file(
        path_of(pkg, "ConversionTest", True),
        pkg,
        imports.write(),
        [
            "/** Tests of the conversions between the application models and the tables. */",
            "class ConversionTest {",
            "    private lateinit var uow: MemoryUnitOfWork"
            if memory
            else "    /** The repositories over the test database, opened empty for every test */",
            not memory and "    private lateinit var uow: SqlUnitOfWork",
            "",
            "    @BeforeTest",
            "    fun open() {",
            "        uow = MemoryUnitOfWork()" if memory else "        uow = TestDatabase.open()",
            *([] if memory else open_test(context)),
            "    }",
            *([] if memory else close_test(context)),
            *[line for test in tests for line in ("", *test)],
            *[line for reader in readers.values() for line in ("", *reader)],
            "}",
        ],
    )


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion objects of a project and the copy of the models they use."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    return [*files, *model_files(context, schema, plans)]
