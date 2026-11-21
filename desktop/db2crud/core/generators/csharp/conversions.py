"""The conversions between the application models and the tables (conversions/plan.py), written in C#: per table, a
static class with one method that turns a model into what the service takes (its create DTO, or the entity) and one
that turns what it returns into the model (asynchronous when it reads other rows). Values are converted between the
model's C# types and the column's (numbers of another size, text, dates and times, nullable values, enums by a
switch), so the project builds; lookups go through the repositories of the unit of work; Mapper's transformations are
plain expressions; what the plan leaves to the user is a `// TODO:` with the reason. Mirrors
web/src/core/generators/csharp/conversions.ts.

Models are built as the application has them: positional records with their constructor, classes with an object
initializer. They are copied into the project (`settings.modelsModule` as their namespace, in PascalCase) or, with
`modelsSource: import`, used from the user's namespace: the copy then goes to `application-models/`, which the
project compiles only while the folder exists (delete it inside the application)."""

import re

from ...conversions.plan import without_hidden
from ...js import js_string
from ..types import lines
from .context import column_of, errors_namespace, find_info, namespace_of, path_of, query, query_name
from .csharp import CsUsings, cs_string, local_name, pascal_name
from .dtos import create_columns, create_dto, read_columns, read_dto

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they are imported from the user's namespace."""


def models_namespace(context: dict) -> str:
    """The namespace of the application models: `app.application_models` → `App.ApplicationModels`."""
    return ".".join(pascal_name(part) for part in context["settings"]["modelsModule"].split("."))


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


def conversions_namespace(context: dict, info: dict) -> str:
    """The namespace of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"{context['base']}.Tables.{info['folder']}"
    return f"{context['base']}.Conversions"


def conversions_class(info: dict) -> str:
    return f"{info['entity']}Conversions"


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its methods (without `Async`), the classes they take and return, and the name the model
    is used by (an alias, `ProductModel`, when it is named like the entity or a DTO of the same file)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    clash = plan["model"] in (info["entity"], target, source)
    model = f"{plan['model']}Model" if clash else plan["model"]
    return {
        "write": f"{model}To{target}",
        "read": f"{source}To{model}",
        "target": target,
        "source": source,
        "model": model,
        "clash": clash,
    }


# Types of the models


def _from_csharp(model: dict) -> bool:
    """A model read from C# keeps its names; the others get C#'s PascalCase."""
    return any(field.get("originalType") is not None for field in model["fields"])


def _member_of(model: dict | None, name: str) -> str:
    return name if model is not None and _from_csharp(model) else pascal_name(name)


_PRIMITIVE_CS = {
    "string": "string",
    "decimal": "decimal",
    "boolean": "bool",
    "date": "DateOnly",
    "datetime": "DateTimeOffset",
    "time": "TimeOnly",
    "duration": "TimeSpan",
    "uuid": "Guid",
    "binary": "byte[]",
    "any": "object",
}


def _type_ref_cs(type_ref: dict) -> str:
    """The C# type of a model's TypeRef, for models not read from C#."""
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        bits = type_ref.get("bits")
        if name == "integer":
            return "int" if bits in (8, 16, 32) else "long"
        if name == "float":
            return "float" if bits == 32 else "double"
        return _PRIMITIVE_CS[name]
    if kind == "array":
        return f"List<{_type_ref_cs(type_ref['items'])}>"
    if kind == "map":
        return f"Dictionary<string, {_type_ref_cs(type_ref['value'])}>"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "object"


def _field_cs(model: dict | None, field: dict) -> str:
    """The C# type of a field, as the model has it (with `?` when it may be null)."""
    if model is not None and _from_csharp(model) and field.get("originalType"):
        return re.sub(r"\s+", " ", field["originalType"]).strip()
    type_text = _type_ref_cs(field["type"])
    return f"{type_text}?" if field.get("nullable") or field.get("optional") else type_text


def _enum_member(item: dict, value: dict) -> str:
    """The constant of an enum value in C#."""
    if isinstance(value.get("value"), (int, float)) and not isinstance(value.get("value"), bool):
        return value["name"]
    if all(re.match(r"^[A-Z][A-Za-z0-9]*$", other["name"]) for other in item["values"]):
        return value["name"]
    return pascal_name(value["name"])


def _enum_text(value: dict) -> str:
    """The text an enum value is stored as: its string value, or its name (C#'s numbered members)."""
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


_VALUE_TYPES = {
    "bool",
    "byte",
    "sbyte",
    "short",
    "ushort",
    "int",
    "uint",
    "long",
    "ulong",
    "float",
    "double",
    "decimal",
    "char",
    "DateTime",
    "DateTimeOffset",
    "DateOnly",
    "TimeOnly",
    "TimeSpan",
    "Guid",
}


def _model_type(models: dict, model: dict) -> list[str]:
    """The class or record of a copied model, as the application has it."""
    fields = [{"type": _field_cs(model, field), "name": _member_of(model, field["name"])} for field in model["fields"]]
    doc = f"/// <summary>{model['name']}, as the application has it.</summary>"
    parent = f" : {model['extends'][0]}" if model.get("extends") else ""
    if model.get("construction") == "positional":
        return [
            doc,
            f"public record {model['name']}(",
            *(
                f"    {field['type']} {field['name']}{',' if index < len(fields) - 1 else ''}"
                for index, field in enumerate(fields)
            ),
            f"){parent};",
        ]
    enums = {item["name"] for item in models["schema"]["enums"]}
    members = []
    for field in fields:
        reference = not field["type"].endswith("?") and field["type"] not in _VALUE_TYPES and field["type"] not in enums
        members.append(f"    public {field['type']} {field['name']} {{ get; set; }}{' = null!;' if reference else ''}")
    return [doc, f"public class {model['name']}{parent}", "{", *members, "}"]


def model_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The copy of the application models the conversions use: a type per file."""
    models = {"schema": schema, "namespace": models_namespace(context)}
    ns = models["namespace"]
    classes, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    copied = context["settings"]["modelsSource"] == "copy"

    def unit(name: str, body: list[str]) -> dict:
        path = path_of(ns, name) if copied else f"{MODELS_FOLDER}/{name}.cs"
        return {"path": path, "content": lines(f"namespace {ns};", "", *body, "")}

    files = [
        unit(
            item["name"],
            [
                f"/// <summary>{item['name']}, as the application has it.</summary>",
                f"public enum {item['name']}",
                "{",
                *(f"    {_enum_member(item, value)}," for value in item["values"]),
                "}",
            ],
        )
        for item in enums
    ]
    files += [unit(model["name"], _model_type(models, model)) for model in classes]
    return files


# Values


def _typed(expression: str, type_text: str, nullable: bool = False, present: bool = False) -> dict:
    return {
        "expression": expression,
        "type": re.sub(r"\?$", "", type_text),
        "nullable": nullable or type_text.endswith("?"),
        "present": present,
    }


_NUMBERS = {"byte", "sbyte", "short", "ushort", "int", "uint", "long", "ulong", "float", "double", "decimal"}
_PARSED = {*_NUMBERS, "DateTime", "DateTimeOffset", "DateOnly", "TimeOnly", "TimeSpan"}


def _core(models: dict, expression: str, source: str, target: str, body: dict) -> str | None:
    """A value that is there, of one C# type, as another; None when DB2CRUD does not convert them."""
    if source == target or target == "object":
        return expression

    def invariant() -> str:
        body["usings"].add("System.Globalization")
        return "CultureInfo.InvariantCulture"

    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == target), None)
    if from_enum and target == "string":
        cases = "".join(
            f"{source}.{_enum_member(from_enum, item)} => {cs_string(_enum_text(item))}, "
            for item in from_enum["values"]
        )
        return f"{expression} switch {{ {cases}_ => throw new ArgumentOutOfRangeException(nameof({source})) }}"
    if to_enum and source == "string":
        cases = "".join(
            f"{cs_string(_enum_text(item))} => {target}.{_enum_member(to_enum, item)}, " for item in to_enum["values"]
        )
        return f'{expression} switch {{ {cases}_ => throw new ArgumentException("No {target} for this value") }}'
    if source in _NUMBERS and target in _NUMBERS:
        return f"({target}){expression}"
    if target == "string":
        if source == "bool":
            return f'({expression} ? "true" : "false")'
        if source in _NUMBERS:
            return f"{expression}.ToString({invariant()})"
        if source in ("DateTime", "DateTimeOffset", "DateOnly", "TimeOnly"):
            return f'{expression}.ToString("O", {invariant()})'
        return f"{expression}.ToString()"
    if source == "string":
        if target in _PARSED:
            return f"{target}.Parse({expression}, {invariant()})"
        if target in ("bool", "Guid"):
            return f"{target}.Parse({expression})"
        return None
    pairs = {
        "DateTimeOffset>DateTime": f"{expression}.UtcDateTime",
        "DateTime>DateTimeOffset": f"new DateTimeOffset(DateTime.SpecifyKind({expression}, DateTimeKind.Utc))",
        "DateTime>DateOnly": f"DateOnly.FromDateTime({expression})",
        "DateTimeOffset>DateOnly": f"DateOnly.FromDateTime({expression}.UtcDateTime)",
        "DateOnly>DateTime": f"{expression}.ToDateTime(TimeOnly.MinValue)",
        "DateOnly>DateTimeOffset": f"new DateTimeOffset({expression}.ToDateTime(TimeOnly.MinValue), TimeSpan.Zero)",
        "TimeOnly>TimeSpan": f"{expression}.ToTimeSpan()",
        "TimeSpan>TimeOnly": f"TimeOnly.FromTimeSpan({expression})",
    }
    return pairs.get(f"{source}>{target}")


def _is_value_type(models: dict, type_text: str) -> bool:
    """Whether a value of this type is a value type (a struct or an enum of the models)."""
    return type_text in _VALUE_TYPES or any(item["name"] == type_text for item in models["schema"]["enums"])


def _convert(models: dict, value: dict, to: str, body: dict) -> str | None:
    """A value as another C# type (`?` when it may be null), or None when DB2CRUD does not convert them. A value that
    may be null stays null when the target takes null."""
    target = re.sub(r"\?$", "", to)
    nullable_target = to.endswith("?")
    expression = value["expression"]
    if not value["nullable"] or value.get("present"):
        return _core(models, expression, value["type"], target, body)
    if value["type"] == target:
        if nullable_target:
            return expression
        return f"({expression} ?? default)" if _is_value_type(models, target) else f"{expression}!"
    inner = f"{expression}.Value" if _is_value_type(models, value["type"]) else expression
    converted = _core(models, inner, value["type"], target, body)
    if converted is None:
        return None
    return f"{expression} is null ? null : ({target}?)({converted})" if nullable_target else converted


def _literal(value) -> dict:
    """A C# literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("null", "object", True)
    if isinstance(value, str):
        return _typed(cs_string(value), "string", False, True)
    if isinstance(value, bool):
        return _typed("true" if value else "false", "bool", False, True)
    if isinstance(value, int) or (isinstance(value, float) and value.is_integer()):
        return _typed(f"{js_string(value)}L", "long", False, True)
    return _typed(js_string(value), "double", False, True)


_INVERSE = {"*": "/", "/": "*", "+": "-", "-": "+"}


def _inverse(transform: dict) -> dict:
    """The transformation that undoes an invertible one."""
    if transform["kind"] == "arithmetic":
        return {**transform, "operator": _INVERSE[transform["operator"]]}
    if transform["kind"] == "enum":
        return {"kind": "enum", "pairs": [{"from": pair["to"], "to": pair["from"]} for pair in transform["pairs"]]}
    return transform


def _text(models: dict, value: dict, body: dict) -> str:
    """A value as the text Mapper compares: enums by their stored text."""
    if any(item["name"] == value["type"] for item in models["schema"]["enums"]):
        converted = _convert(models, value, "string?", body)
        return value["expression"] if converted is None else converted
    return value["expression"]


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]

    def present(item: dict) -> dict:
        # A value a transformation uses is taken as there: a nullable struct by its Value
        nullable_struct = item["nullable"] and not item.get("present") and _is_value_type(models, item["type"])
        expression = f"{item['expression']}!.Value" if nullable_struct else item["expression"]
        return {**item, "expression": expression, "present": True}

    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(_text(models, item, body) for item in values)
        return _typed(f"string.Join({cs_string(transform['separator'])}, {parts})", "string", False, True)
    if kind == "split":
        separator = cs_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"Rest({_text(models, value, body)}, {separator})", "string", False, True)
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"Part({_text(models, value, body)}, {separator}, {part})", "string", False, True)
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        body["helpers"].add("pair")
        items = ", ".join(cs_string(item) for item in transform["trueValues"])
        return _typed(f"new[] {{ {items} }}.Contains(Text({_text(models, value, body)}))", "bool", False, True)
    if kind == "enum":
        body["helpers"].add("pair")
        pairs = ", ".join(f"[{cs_string(pair['from'])}] = {cs_string(pair['to'])}" for pair in transform["pairs"])
        fallback = cs_string(transform["fallback"]) if transform.get("fallback") is not None else "null"
        expression = f"Pair(new Dictionary<string, string> {{ {pairs} }}, {_text(models, value, body)}, {fallback})"
        return _typed(expression, "string", False, True)
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        plain = re.sub(r"\?$", "", target)
        # From a date and time: a number; from a number: a date and time
        if plain in _NUMBERS or plain == "string":
            moment = _convert(models, present(value), "DateTimeOffset", body)
            if moment is None:
                return None
            method = "ToUnixTimeMilliseconds()" if milliseconds else "ToUnixTimeSeconds()"
            return _typed(f"({moment}).{method}", "long", False, True)
        number = _convert(models, present(value), "long", body)
        if number is None:
            return None
        method = "FromUnixTimeMilliseconds" if milliseconds else "FromUnixTimeSeconds"
        return _typed(f"DateTimeOffset.{method}({number})", "DateTimeOffset", False, True)
    if kind == "arithmetic":
        number = _convert(models, present(value), "double", body)
        if number is None:
            return None
        operand = re.sub(r"L$", "", _literal(transform["operand"])["expression"])
        return _typed(f"({number} {transform['operator']} {operand})", "double", False, True)
    return None


def _fit(models: dict, result: dict, to: str, body: dict) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, then converted."""
    whole = re.sub(r"\?$", "", to) in ("byte", "sbyte", "short", "ushort", "int", "uint", "long", "ulong")
    if whole and result["type"] in ("double", "float"):
        result = {**result, "expression": f"Math.Round({result['expression']})"}
    return _convert(models, result, to, body)


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


def _comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def _argument_lines(values: list[dict], indent: str) -> list[str]:
    """The arguments of a constructor, one per line."""
    return [
        f"{indent}{value['expression']}{',' if index < len(values) - 1 else ''}{_comment(value)}"
        for index, value in enumerate(values)
    ]


def _initializer_lines(values: list[dict], indent: str) -> list[str]:
    """The members of an object initializer, one per line."""
    return [f"{indent}{value['name']} = {value['expression']},{_comment(value)}" for value in values]


def _walk(models: dict, model: dict | None, path: list[str], root: str) -> dict | None:
    """The field of a model a path names, with how it is read, walking nested models."""
    current = model
    expression = root
    result = None
    for part in path:
        field = next((item for item in current["fields"] if item["name"] == part), None) if current else None
        if current is None or field is None:
            return None
        nullable = result["nullable"] if result else False
        expression = f"{expression}{'?' if nullable else ''}.{_member_of(current, field['name'])}"
        result = _typed(expression, _field_cs(current, field), nullable)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return result


def _column_typed(column: dict, root: str) -> dict:
    return _typed(f"{root}.{column['prop']}", column["propType"])


def _write_expression(context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": "default!", "todo": f"{_WHY['unsupported']} ({detail})"}

    def source(path: list[str]) -> dict | None:
        return _walk(models, model, path, "model")

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(column["prop"])
        converted = _fit(models, result, column["propType"], body)
        if converted is None:
            return unsupported(f"{result['type']} to {column['cs']}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "field":
        return finish(source(value["path"]))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        given = source(value["path"])
        if not other or not finder or not given:
            return {"expression": "default!", "todo": "no repository query finds the row it names"}
        by = column_of(other, value["by"])
        argument = _convert(models, given, by["cs"], body)
        if argument is None:
            return unsupported(f"{given['type']} to {by['cs']}")
        name = local_name(other["entity"])
        body["uow"] = True
        body["usings"].add(errors_namespace(context))
        fallback = ' ?? ""' if given["nullable"] else ""
        body["lines"] += [
            f"var {name} = await uow.{other['attr']}.{query_name(context, finder)}({argument})",
            f"    ?? throw new NotFoundException({cs_string(other['entity'])}, {given['expression']}{fallback});",
        ]
        return finish(_column_typed(column_of(other, value["key"]), name))
    if kind == "mapper":
        sources = [source(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["prop"])
        return finish(_transformed(models, value["transform"], sources, column["propType"], body))
    given = source(value["path"])
    return finish(given and _transformed(models, _inverse(value["transform"]), [given], column["propType"], body))


def _read_expression(
    context: dict, models: dict, info: dict, model: dict, field: dict, value: dict, body: dict
) -> dict:
    target = _field_cs(model, field)

    def unsupported(detail: str) -> dict:
        return {"expression": "default!", "todo": f"{_WHY['unsupported']} ({detail})"}

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(field["name"])
        converted = _fit(models, result, target, body)
        if converted is None:
            return unsupported(f"{result['type']} to {target}")
        return {"expression": converted}

    kind = value["kind"]
    if kind == "column":
        return finish(_column_typed(column_of(info, value["column"]), "row"))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = (query(other, "getByKey") or query(other, "findByUnique", [value["key"]])) if other else None
        if not other or not finder:
            return {"expression": "default!", "todo": "no repository query reads it"}
        name = local_name(other["entity"])
        own = column_of(info, value["column"])
        body["uow"] = True
        argument = f"row.{own['prop']}{'.Value' if own['optional'] and own['valueType'] else ''}"
        found = f"await uow.{other['attr']}.{query_name(context, finder)}({argument})"
        body["lines"].append(
            f"var {name} = row.{own['prop']} is null ? null : {found};" if own["optional"] else f"var {name} = {found};"
        )
        by = column_of(other, value["by"])
        access = f"{name}{'?' if own['optional'] else '!'}.{by['prop']}"
        return finish(_typed(access, by["propType"], own["optional"]))
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": "default!", "todo": "no repository query reads it"}
        body["uow"] = True
        item = _column_typed(column_of(other, value["value"]), "item")
        listed = re.match(r"^(?:List|IList|IEnumerable|ICollection|IReadOnlyList)<(.+)>\??$", target)
        array = re.match(r"^(.+)\[\]\??$", target)
        element = listed.group(1) if listed else array.group(1) if array else item["type"]
        converted = _convert(models, item, element, body)
        if converted is None:
            return unsupported(f"{item['type']} to {element}")
        key = column_of(info, value["key"])
        suffix = "!.Value" if key["optional"] and key["valueType"] else ""
        rows = f"(await uow.{other['attr']}.{query_name(context, lister)}(row.{key['prop']}{suffix}))"
        return {"expression": f"{rows}.Select(item => {converted}).{'ToArray' if array else 'ToList'}()"}
    if kind == "mapper":
        columns = [_column_typed(column_of(info, name), "row") for name in value["columns"]]
        return finish(_transformed(models, value["transform"], columns, target, body))
    column = _column_typed(column_of(info, value["column"]), "row")
    return finish(_transformed(models, _inverse(value["transform"]), [column], target, body))


_HELPERS = {
    "pair": [
        "/// <summary>A value as the text Mapper compares.</summary>",
        'private static string Text(object? value) => Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";',
        "",
        "/// <summary>The value an enum pair gives, or the fallback; a value without a pair is an error.</summary>",
        "private static string Pair(Dictionary<string, string> pairs, object? value, string? fallback) =>",
        "    pairs.TryGetValue(Text(value), out var found) ? found : fallback"
        ' ?? throw new ArgumentException($"No pair for {value}");',
    ],
    "part": [
        "/// <summary>One part of a text split by a separator (the last one for -1), or an empty text.</summary>",
        "private static string Part(object? value, string separator, int index)",
        "{",
        '    var parts = (Convert.ToString(value, CultureInfo.InvariantCulture) ?? "").Split(separator);',
        "    var at = index < 0 ? parts.Length - 1 : index;",
        '    return at < parts.Length ? parts[at] : "";',
        "}",
    ],
    "rest": [
        "/// <summary>What follows the first separator of a text, or an empty text.</summary>",
        "private static string Rest(object? value, string separator)",
        "{",
        '    var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";',
        "    var at = text.IndexOf(separator, StringComparison.Ordinal);",
        '    return at < 0 ? "" : text[(at + separator.Length)..];',
        "}",
    ],
}


def _signature(uow: bool, result: str, name: str, param: str) -> str:
    if uow:
        return f"    public static async Task<{result}> {name}Async({param}, IUnitOfWork uow)"
    return f"    public static {result} {name}({param})"


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The class of the conversions of one table: one method per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    models = {"schema": schema, "namespace": models_namespace(context)}
    ns = conversions_namespace(context, info)
    usings = CsUsings(ns)
    aliases: set[str] = set()
    helpers: set[str] = set()
    methods: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    record = context["settings"]["dtoKind"] != "class"
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        if names["clash"]:
            aliases.add(f"using {names['model']} = {models['namespace']}.{plan['model']};")
        else:
            usings.add(models["namespace"])
        usings.add(namespace_of(context, info, "dtos" if dtos else "entity"))
        if plan["write"] is not None:
            body = {"lines": [], "uow": False, "usings": usings, "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["prop"], "expression": "default!", "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body)
                    values.append({"name": column["prop"], **written})
            if dtos and record:
                # Every value of the create DTO, in its order; those the model does not give are null
                every = [
                    next(
                        (value for value in values if value["name"] == column["prop"]),
                        {"name": column["prop"], "expression": "null"},
                    )
                    for column in create_columns(info)
                ]
                result = [
                    f"        return new {names['target']}(",
                    *_argument_lines(every, "            "),
                    "        );",
                ]
            else:
                result = [
                    f"        return new {names['target']}",
                    "        {",
                    *_initializer_lines(values, "            "),
                    "        };",
                ]
            if body["uow"]:
                usings.add(context["base"])
            methods.append(
                [
                    f"    /// <summary>{_article(plan['model'])} as the {info['name']} table takes it.</summary>",
                    _signature(body["uow"], names["target"], names["write"], f"{names['model']} model"),
                    "    {",
                    *(f"        {line}" for line in body["lines"]),
                    *result,
                    "    }",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "uow": False, "usings": usings, "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = _member_of(model, field["name"])
                if item is None:
                    values.append({"name": name, "expression": "default!"})
                elif item["value"]["kind"] == "todo":
                    values.append({"name": name, "expression": "default!", "todo": _todo_text(item["value"])})
                else:
                    read = _read_expression(context, models, info, model, field, item["value"], body)
                    values.append({"name": name, **read})
            given = {_member_of(model, item["field"]) for item in plan["read"]}
            if body["uow"]:
                usings.add(context["base"])
            if model.get("construction") == "positional":
                result = [
                    f"        return new {names['model']}(",
                    *_argument_lines(values, "            "),
                    "        );",
                ]
            else:
                # Built by its properties: the fields the plan does not give keep the model's defaults
                chosen = [value for value in values if value["name"] in given]
                result = [
                    f"        return new {names['model']}",
                    "        {",
                    *_initializer_lines(chosen, "            "),
                    "        };",
                ]
            article = _article(plan["model"]).split(" ")[0].lower()
            methods.append(
                [
                    f"    /// <summary>A row of the {info['name']} table as {article} {plan['model']}.</summary>",
                    _signature(body["uow"], names["model"], names["read"], f"{names['source']} row"),
                    "    {",
                    *(f"        {line}" for line in body["lines"]),
                    *result,
                    "    }",
                ]
            )
    if helpers:
        usings.add("System.Globalization")
    helper_blocks = [
        [f"    {line}" if line else "" for line in _HELPERS[name]]
        for name in ("pair", "part", "rest")
        if name in helpers
    ]
    name = conversions_class(info)
    written = usings.write()
    blocks = [*methods, *helper_blocks]
    content = lines(
        written != "" and written,
        *sorted(aliases),
        (written != "" or bool(aliases)) and "",
        f"namespace {ns};",
        "",
        f'/// <summary>Conversions between the application models and the "{info["name"]}" table: what the service'
        " takes and returns.</summary>",
        f"public static class {name}",
        "{",
        *[line for index, block in enumerate(blocks) for line in ([""] if index > 0 else []) + block],
        "}",
        "",
    )
    return {"path": path_of(ns, name), "content": content}


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def conversion_test_file(
    context: dict, plans: list[dict], schema: dict, can_make, database_members: list
) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    ns = f"{context['base']}.Tests"
    usings = CsUsings(ns).add("Xunit", context["base"])
    memory = context["settings"]["memoryRepositories"]
    record = context["settings"]["dtoKind"] != "class"
    tests: list[list[str]] = []
    readers: dict[str, str] = {}
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
        reads = any(item["value"]["kind"] in ("lookup", "children") for item in plan["read"])
        writes = plan["write"] is not None and not _has_todo(plan["write"])
        write_uow = writes and any(item["value"]["kind"] == "lookup" for item in plan["write"])
        usings.add(conversions_namespace(context, info), namespace_of(context, info, "entity"))
        reader = f"{names['source']}Of"
        if dtos and info["name"] not in readers:
            usings.add(namespace_of(context, info, "dtos"))
            columns = read_columns(info)
            if record:
                arguments = ", ".join(f"entity.{column['prop']}" for column in columns)
                readers[info["name"]] = (
                    f"    private static {names['source']} {reader}({info['entity']} entity) => new({arguments});"
                )
            else:
                members = ", ".join(f"{column['prop']} = entity.{column['prop']}" for column in columns)
                readers[info["name"]] = (
                    f"    private static {names['source']} {reader}({info['entity']} entity) => new() {{ {members} }};"
                )
        klass = conversions_class(info)

        def call(is_async: bool, method: str, argument: str, klass: str = klass) -> str:
            return f"await {klass}.{method}Async({argument}, uow)" if is_async else f"{klass}.{method}({argument})"

        body = [
            f"var row = await Factories.Add{info['entity']}Async(uow, 1);",
            f"var model = {call(reads, names['read'], f'{reader}(row)' if dtos else 'row')};",
        ]
        if writes:
            body.append(f"var values = {call(write_uow, names['write'], 'model')};")
            for item in plan["write"]:
                prop = column_of(info, item["column"])["prop"]
                body.append(f"Assert.Equal(row.{prop}, values.{prop});")
        else:
            body.append("Assert.NotNull(model);")
        method = f"Reads{plan['model']}AndWritesItBack" if writes else f"Reads{plan['model']}"
        tests.append(
            ["    [Fact]", f"    public async Task {method}()", "    {", *(f"        {line}" for line in body), "    }"]
        )
    if not tests:
        return None
    content = lines(
        usings.write(),
        "",
        f"namespace {ns};",
        "",
        "/// <summary>Tests of the conversions between the application models and the tables.</summary>",
        "public class ConversionTests" if memory else "public class ConversionTests : IAsyncLifetime",
        "{",
        "    private readonly MemoryUnitOfWork uow = new();" if memory else database_members,
        *[line for test in tests for line in ("", *test)],
        *[line for reader in readers.values() for line in ("", reader)],
        "}",
        "",
    )
    return {"path": path_of(ns, "ConversionTests", True), "content": content}


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion classes of a project and the copy of the models they use."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    return [*files, *model_files(context, schema, plans)]
