"""The conversions between the application models and the tables (conversions/plan.py), written in PHP: per table, a
final class of static methods, one that turns a model into what the service takes (its create DTO, or the entity) and
one that turns what it returns into the model. Values are converted between the model's PHP types and the column's
(int, float and text, decimals kept as text, dates and times, enums by a match), as strict types ask; lookups go
through the repositories of the unit of work; Mapper's transformations are plain expressions; what the plan leaves to
the user is a `// TODO:` with the reason. Mirrors web/src/core/generators/php/common/conversions.ts.

Models are read and built as the application has them: public properties or getters, a constructor with named
arguments or properties set one by one. They are copied into the project (`settings.modelsModule` as their namespace,
in PascalCase) or, with `modelsSource: import`, used from the user's namespace: the copy then goes to
`application-models/`, which Composer loads for that namespace (delete it inside the application)."""

import re

from ....conversions.plan import without_hidden
from .context import (
    class_name,
    column_of,
    error_class,
    find_info,
    namespace_of,
    path_of,
    php_file,
    query,
    query_name,
    root_class,
)
from .dtos import create_dto, read_columns, read_dto
from .php import PhpUses, access, field_name, pascal_name, php_literal, php_string
from .tests import test_file

MODELS_FOLDER = "application-models"
"""The folder of the copy of the models when they are imported from the user's namespace."""


def models_namespace(context: dict) -> str:
    """The namespace of the application models: `app.application_models` → `App\\ApplicationModels`."""
    return "\\".join(pascal_name(part) for part in context["settings"]["modelsModule"].split("."))


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
        return f"{context['base']}\\Tables\\{info['folder']}"
    return f"{context['base']}\\Conversions"


def conversions_class(info: dict) -> str:
    return f"{info['entity']}Conversions"


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its methods, the classes they take and return, and the name the model is used by (an
    alias, `ProductModel`, when it is named like the entity or a DTO of the same file)."""
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


def _from_php(model: dict) -> bool:
    """A model read from PHP keeps its names; the others get PHP's camelCase."""
    return any(field.get("originalType") is not None for field in model["fields"])


def _member_of(model: dict | None, name: str) -> str:
    return name if model is not None and _from_php(model) else field_name(name)


_PRIMITIVE_PHP = {
    "string": "string",
    "integer": "int",
    "float": "float",
    "decimal": "string",
    "boolean": "bool",
    "date": "\\DateTimeImmutable",
    "datetime": "\\DateTimeImmutable",
    "time": "\\DateTimeImmutable",
    "duration": "string",
    "uuid": "string",
    "binary": "string",
    "any": "mixed",
}


def _type_ref_php(type_ref: dict) -> str:
    """The PHP type of a model's TypeRef, for models not read from PHP."""
    kind = type_ref["kind"]
    if kind == "primitive":
        return _PRIMITIVE_PHP[type_ref["name"]]
    if kind in ("array", "map"):
        return "array"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "mixed"


def _field_php(model: dict | None, field: dict) -> str:
    """The PHP type of a field, as the model has it (with `?` when it may be null)."""
    if model is not None and _from_php(model) and field.get("originalType"):
        return field["originalType"].strip()
    type_text = _type_ref_php(field["type"])
    return f"?{type_text}" if (field.get("nullable") or field.get("optional")) and type_text != "mixed" else type_text


def _style_of(model: dict) -> tuple[bool, bool]:
    """How a model is read and built: with getters, and with a constructor of named arguments."""
    metadata = model.get("metadata") or {}
    return metadata.get("accessors") == "getters", model.get("construction") == "named"


def _enum_case(item: dict, value: dict) -> str:
    """The case of an enum value in PHP."""
    if all(re.match(r"^[A-Z][A-Za-z0-9]*$", other["name"]) for other in item["values"]):
        return value["name"]
    return pascal_name(value["name"])


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


def _capitalized(name: str) -> str:
    return name[:1].upper() + name[1:]


def _model_class(model: dict) -> list[str]:
    """The class of a copied model, as the application has it."""
    getters, named = _style_of(model)
    fields = [{"type": _field_php(model, field), "name": _member_of(model, field["name"])} for field in model["fields"]]
    doc = f"/** {model['name']}, as the application has it. */"
    parent = f" extends {model['extends'][0]}" if model.get("extends") else ""
    if named:
        return [
            doc,
            f"class {model['name']}{parent}",
            "{",
            "    public function __construct(",
            *(f"        public {field['type']} ${field['name']}," for field in fields),
            "    ) {",
            "    }",
            "}",
        ]
    if not getters:
        return [
            doc,
            f"class {model['name']}{parent}",
            "{",
            *(f"    public {field['type']} ${field['name']};" for field in fields),
            "}",
        ]
    body = [f"    private {field['type']} ${field['name']};" for field in fields]
    for field in fields:
        body += [
            "",
            f"    public function get{_capitalized(field['name'])}(): {field['type']}",
            "    {",
            f"        return $this->{field['name']};",
            "    }",
            "",
            f"    public function set{_capitalized(field['name'])}({field['type']} ${field['name']}): void",
            "    {",
            f"        $this->{field['name']} = ${field['name']};",
            "    }",
        ]
    return [doc, f"class {model['name']}{parent}", "{", *body, "}"]


def model_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The copy of the application models the conversions use: a class or enum per file."""
    ns = models_namespace(context)
    models, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    copied = context["settings"]["modelsSource"] == "copy"

    def path(name: str) -> str:
        return path_of(ns, name) if copied else f"{MODELS_FOLDER}/{name}.php"

    files = []
    for item in enums:
        values = item["values"]
        if all(isinstance(value.get("value"), str) for value in values):
            backing = ": string"
        elif all(
            isinstance(value.get("value"), (int, float)) and not isinstance(value.get("value"), bool)
            for value in values
        ):
            backing = ": int"
        else:
            backing = ""
        cases = [
            f"    case {_enum_case(item, value)}{' = ' + php_literal(value['value']) if backing else ''};"
            for value in values
        ]
        body = [f"/** {item['name']}, as the application has it. */", f"enum {item['name']}{backing}", "{", *cases, "}"]
        files.append(php_file(path(item["name"]), ns, "", body))
    files += [php_file(path(model["name"]), ns, "", _model_class(model)) for model in models]
    return files


# Values


def _typed(expression: str, type_text: str, nullable: bool = False, present: bool = False) -> dict:
    return {
        "expression": expression,
        "type": re.sub(r"^\\", "", re.sub(r"^\?", "", type_text)),
        "nullable": nullable or type_text.startswith("?"),
        "present": present,
    }


_DATES = {"DateTimeImmutable", "DateTimeInterface", "DateTime"}


def _core(models: dict, expression: str, source: str, target: str) -> str | None:
    """A value that is there, of one PHP type, as another; None when DB2CRUD does not convert them."""
    if source == target or target == "mixed" or (source in _DATES and target in _DATES):
        return expression
    from_enum = next((item for item in models["schema"]["enums"] if item["name"] == source), None)
    to_enum = next((item for item in models["schema"]["enums"] if item["name"] == target), None)
    for item in (from_enum, to_enum):
        if item and models.get("uses") is not None:
            models["uses"].add(class_name(models["namespace"], item["name"]))
    if from_enum and target == "string":
        cases = ", ".join(
            f"{source}::{_enum_case(from_enum, item)} => {php_string(_enum_text(item))}" for item in from_enum["values"]
        )
        return f"match ({expression}) {{ {cases} }}"
    if to_enum and source == "string":
        cases = ", ".join(
            f"{php_string(_enum_text(item))} => {target}::{_enum_case(to_enum, item)}" for item in to_enum["values"]
        )
        return f"match ({expression}) {{ {cases}, default => throw new \\ValueError('No {target} for this value') }}"
    if target == "int" and source in ("float", "string", "bool"):
        return f"(int) {expression}"
    if target == "float" and source in ("int", "string"):
        return f"(float) {expression}"
    if target == "string":
        if source in ("int", "float"):
            return f"(string) {expression}"
        if source == "bool":
            return f"({expression} ? 'true' : 'false')"
        if source in _DATES:
            return f"{expression}->format(DATE_ATOM)"
        return None
    if source == "string":
        if target == "bool":
            return f"filter_var({expression}, FILTER_VALIDATE_BOOLEAN)"
        if target in _DATES:
            return f"new \\DateTimeImmutable({expression})"
    return None


def _convert(models: dict, value: dict, to: str) -> str | None:
    """A value as another PHP type (`?` when it may be null), or None when DB2CRUD does not convert them. A value that
    may be null stays null."""
    target = re.sub(r"^\\", "", re.sub(r"^\?", "", to))
    converted = _core(models, value["expression"], value["type"], target)
    if converted is None or converted == value["expression"] or not value["nullable"] or value.get("present"):
        return converted
    return f"({value['expression']} === null ? null : {converted})"


def _literal(value) -> dict:
    """A PHP literal of a Mapper constant, with its type."""
    if value is None:
        return _typed("null", "mixed", True)
    if isinstance(value, str):
        return _typed(php_string(value), "string", False, True)
    if isinstance(value, bool):
        return _typed("true" if value else "false", "bool", False, True)
    whole = isinstance(value, int) or (isinstance(value, float) and value.is_integer())
    return _typed(php_literal(value), "int" if whole else "float", False, True)


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
    if any(item["name"] == value["type"] for item in models["schema"]["enums"]):
        converted = _convert(models, value, "?string")
        return value["expression"] if converted is None else converted
    if value["type"] == "string":
        return value["expression"]
    return f"(string) {value['expression']}"


def _transformed(models: dict, transform: dict, values: list[dict], target: str, body: dict) -> dict | None:
    """A Mapper transformation of typed values, as an expression of the type it gives; None when it cannot be
    written."""
    value = values[0]

    def present(item: dict) -> dict:
        return {**item, "present": True}

    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        parts = ", ".join(_text(models, item) for item in values)
        return _typed(f"implode({php_string(transform['separator'])}, [{parts}])", "string", False, True)
    if kind == "split":
        separator = php_string(transform["separator"])
        if transform["part"] == "rest":
            body["helpers"].add("rest")
            return _typed(f"self::rest({_text(models, value)}, {separator})", "string", False, True)
        body["helpers"].add("part")
        part = -1 if transform["part"] == "last" else transform["part"]
        return _typed(f"self::part({_text(models, value)}, {separator}, {part})", "string", False, True)
    if kind == "constant":
        return _literal(transform["value"])
    if kind == "boolean":
        items = ", ".join(php_string(item) for item in transform["trueValues"])
        return _typed(f"in_array({_text(models, value)}, [{items}], true)", "bool", False, True)
    if kind == "enum":
        body["helpers"].add("pair")
        pairs = ", ".join(f"{php_string(pair['from'])} => {php_string(pair['to'])}" for pair in transform["pairs"])
        fallback = php_string(transform["fallback"]) if transform.get("fallback") is not None else "null"
        return _typed(f"self::pair([{pairs}], {_text(models, value)}, {fallback})", "string", False, True)
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        plain = re.sub(r"^\?", "", target)
        # From a date and time: a number; from a number: a date and time
        if plain in ("int", "float", "string"):
            moment = _convert(models, present(value), "DateTimeImmutable")
            if moment is None:
                return None
            return _typed(f"{moment}->getTimestamp(){' * 1000' if milliseconds else ''}", "int", False, True)
        number = _convert(models, present(value), "int")
        if number is None:
            return None
        seconds = f"intdiv({number}, 1000)" if milliseconds else number
        return _typed(f"new \\DateTimeImmutable('@' . {seconds})", "DateTimeImmutable", False, True)
    if kind == "arithmetic":
        number = _convert(models, present(value), "float")
        if number is None:
            return None
        operand = _literal(transform["operand"])["expression"]
        return _typed(f"({number} {transform['operator']} {operand})", "float", False, True)
    return None


def _fit(models: dict, result: dict, to: str, column: dict | None = None) -> str | None:
    """A typed value as the type a column or field has: whole numbers rounded, decimals with their scale."""
    plain = re.sub(r"^\?", "", to)
    if result["type"] == "float" and plain == "int":
        return f"(int) round({result['expression']})"
    if result["type"] == "float" and plain == "string" and column and column["column"]["type"]["kind"] == "decimal":
        scale = column["column"]["type"].get("scale") or 0
        return f"number_format({result['expression']}, {scale}, '.', '')"
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


def _read(model: dict, field: dict, root: str) -> str:
    """How a field of a model is read: `$model->name` or `$model->getName()`."""
    name = _member_of(model, field["name"])
    return f"{root}->get{_capitalized(name)}()" if _style_of(model)[0] else access(root, name)


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
        expression = re.sub(r"->(?=[^>]*$)", "?->" if nullable else "->", _read(current, field, expression), count=1)
        result = _typed(expression, _field_php(current, field), nullable)
        current = (
            next((item for item in models["schema"]["models"] if item["name"] == field["type"]["name"]), None)
            if field["type"]["kind"] == "model"
            else None
        )
    return result


def _write_expression(context: dict, models: dict, column: dict, value: dict, model: dict | None, body: dict) -> dict:
    def unsupported(detail: str) -> dict:
        return {"expression": None, "todo": f"{_WHY['unsupported']} ({detail})"}

    def source(path: list[str]) -> dict | None:
        return _walk(models, model, path, "$model")

    def finish(result: dict | None) -> dict:
        if result is None:
            return unsupported(column["field"])
        converted = _fit(models, result, column["php"], column)
        if converted is None:
            return unsupported(f"{result['type']} to {column['php']}")
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
        argument = _convert(models, given, by["php"])
        if argument is None:
            return unsupported(f"{given['type']} to {by['php']}")
        name = f"${field_name(other['entity'])}"
        body["uow"] = True
        body["uses"].add(error_class(context, "NotFoundException"))
        body["lines"] += [
            f"{name} = $uow->{other['attr']}->{query_name(context, finder)}({argument})",
            f"    ?? throw new NotFoundException({php_string(other['entity'])}, {given['expression']});",
        ]
        key = column_of(other, value["key"])
        return finish(_typed(access(name, key["prop"]), key["php"]))
    if kind == "mapper":
        sources = [source(path) for path in value["sources"]]
        if any(item is None for item in sources):
            return unsupported(column["field"])
        return finish(_transformed(models, value["transform"], sources, column["php"], body))
    given = source(value["path"])
    return finish(given and _transformed(models, _inverse(value["transform"]), [given], column["php"], body))


def _read_expression(
    context: dict, models: dict, info: dict, dtos: bool, model: dict, field: dict, value: dict, body: dict
) -> dict:
    target = _field_php(model, field)

    def own(name: str) -> dict:
        # What the service returns: a DTO by its fields, an entity by its properties
        column = column_of(info, name)
        expression = f"$row->{column['field']}" if dtos else access("$row", column["prop"])
        return _typed(expression, column["php"], column["column"]["nullable"])

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
        name = f"${field_name(other['entity'])}"
        key = own(value["column"])
        body["uow"] = True
        found = f"$uow->{other['attr']}->{query_name(context, finder)}({key['expression']})"
        body["lines"].append(
            f"{name} = {key['expression']} === null ? null : {found};" if key["nullable"] else f"{name} = {found};"
        )
        by = column_of(other, value["by"])
        return finish(_typed(access(name, by["prop"]).replace("->", "?->", 1), by["php"], True))
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return {"expression": None, "todo": "no repository query reads it"}
        body["uow"] = True
        item = column_of(other, value["value"])
        element = _type_ref_php(field["type"]["items"]) if field["type"]["kind"] == "array" else item["php"]
        converted = _convert(models, _typed(access("$item", item["prop"]), item["php"]), element)
        if converted is None:
            return unsupported(f"{item['php']} to {element}")
        rows = f"$uow->{other['attr']}->{query_name(context, lister)}({own(value['key'])['expression']})"
        return {"expression": f"array_map(fn ($item) => {converted}, {rows})"}
    if kind == "mapper":
        return finish(_transformed(models, value["transform"], [own(name) for name in value["columns"]], target, body))
    return finish(_transformed(models, _inverse(value["transform"]), [own(value["column"])], target, body))


_HELPERS = {
    "pair": [
        "/**",
        " * The value an enum pair gives, or the fallback; a value without a pair is an error.",
        " *",
        " * @param array<string, string> $pairs",
        " */",
        "private static function pair(array $pairs, string $value, ?string $fallback): string",
        "{",
        '    return $pairs[$value] ?? $fallback ?? throw new \\ValueError("No pair for {$value}");',
        "}",
    ],
    "part": [
        "/** One part of a text split by a separator (the last one for -1), or an empty text. */",
        "private static function part(string $value, string $separator, int $index): string",
        "{",
        "    $parts = explode($separator, $value);",
        "    return $parts[$index < 0 ? count($parts) - 1 : $index] ?? '';",
        "}",
    ],
    "rest": [
        "/** What follows the first separator of a text, or an empty text. */",
        "private static function rest(string $value, string $separator): string",
        "{",
        "    $at = strpos($value, $separator);",
        "    return $at === false ? '' : substr($value, $at + strlen($separator));",
        "}",
    ],
}


def _comment(value: dict) -> str:
    return f" // TODO: {value['name']}: {value['todo']}" if value.get("todo") else ""


def _todo_line(value: dict, indent: str) -> str:
    return f"{indent}//{_comment(value)[3:]}"


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The class of the conversions of one table: one method per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    ns = conversions_namespace(context, info)
    uses = PhpUses(ns)
    models = {"schema": schema, "namespace": models_namespace(context), "uses": uses}
    helpers: set[str] = set()
    methods: list[list[str]] = []
    dtos = _uses_dtos(context, info)
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        alias = f" as {names['model']}" if names["clash"] else ""
        uses.add(f"{class_name(models['namespace'], plan['model'])}{alias}")
        if plan["write"] is not None:
            body = {"lines": [], "uses": uses, "uow": False, "helpers": helpers}
            values = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    values.append({"name": column["field"], "expression": None, "todo": _todo_text(item["value"])})
                else:
                    written = _write_expression(context, models, column, item["value"], model, body)
                    values.append({"name": column["field"], **written})
            if dtos:
                uses.add(class_name(namespace_of(context, info, "dtos"), names["target"]))
                # Named arguments: the fields left out take their default, null
                result = [f"    return new {names['target']}("]
                for value in values:
                    if value["expression"] is None:
                        result.append(_todo_line(value, "        "))
                    else:
                        result.append(f"        {value['name']}: {value['expression']},{_comment(value)}")
                result.append("    );")
            else:
                uses.add(class_name(namespace_of(context, info, "entity"), info["entity"]))
                result = [f"    $entity = new {info['entity']}();"]
                for value in values:
                    column = next(item for item in info["columns"] if item["field"] == value["name"])
                    if value["expression"] is None:
                        result.append(_todo_line(value, "    "))
                    else:
                        target = access("$entity", column["prop"])
                        result.append(f"    {target} = {value['expression']};{_comment(value)}")
                result.append("    return $entity;")
            if body["uow"]:
                uses.add(root_class(context, "UnitOfWork"))
            params = f"{names['model']} $model{', UnitOfWork $uow' if body['uow'] else ''}"
            methods.append(
                [
                    f"/** {_article(plan['model'])} as the {info['name']} table takes it. */",
                    f"public static function {names['write']}({params}): {names['target']}",
                    "{",
                    *(f"    {line}" for line in body["lines"]),
                    *result,
                    "}",
                ]
            )
        if plan["read"] is not None and model is not None:
            body = {"lines": [], "uses": uses, "uow": False, "helpers": helpers}
            values = []
            for field in model["fields"]:
                item = next((candidate for candidate in plan["read"] if candidate["field"] == field["name"]), None)
                name = _member_of(model, field["name"])
                if item is None:
                    values.append({"name": name, "expression": None})
                elif item["value"]["kind"] == "todo":
                    values.append({"name": name, "expression": None, "todo": _todo_text(item["value"])})
                else:
                    read = _read_expression(context, models, info, dtos, model, field, item["value"], body)
                    values.append({"name": name, **read})
            uses.add(class_name(namespace_of(context, info, "dtos" if dtos else "entity"), names["source"]))
            if body["uow"]:
                uses.add(root_class(context, "UnitOfWork"))
            getters, named = _style_of(model)
            if named:
                result = [
                    f"    return new {names['model']}(",
                    *(
                        f"        {value['name']}: {value['expression'] or 'null'},{_comment(value)}"
                        for value in values
                    ),
                    "    );",
                ]
            else:
                # Built by its properties: the fields the plan does not give keep the model's defaults
                result = [f"    $model = new {names['model']}();"]
                for value in values:
                    if value["expression"] is None and not value.get("todo"):
                        continue
                    if value["expression"] is None:
                        result.append(_todo_line(value, "    "))
                    elif getters:
                        setter = f"set{_capitalized(value['name'])}"
                        result.append(f"    $model->{setter}({value['expression']});{_comment(value)}")
                    else:
                        result.append(
                            f"    {access('$model', value['name'])} = {value['expression']};{_comment(value)}"
                        )
                result.append("    return $model;")
            article = _article(plan["model"]).split(" ")[0].lower()
            params = f"{names['source']} $row{', UnitOfWork $uow' if body['uow'] else ''}"
            methods.append(
                [
                    f"/** A row of the {info['name']} table as {article} {plan['model']}. */",
                    f"public static function {names['read']}({params}): {names['model']}",
                    "{",
                    *(f"    {line}" for line in body["lines"]),
                    *result,
                    "}",
                ]
            )
    blocks = [*methods, *(_HELPERS[name] for name in ("pair", "part", "rest") if name in helpers)]
    name = conversions_class(info)
    lines_ = [
        f'/** Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        " returns. */",
        f"final class {name}",
        "{",
    ]
    for index, block in enumerate(blocks):
        if index > 0:
            lines_.append("")
        lines_ += [f"    {line}" if line else "" for line in block]
    lines_.append("}")
    return php_file(path_of(ns, name), ns, uses.write(), lines_)


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def conversion_test_file(context: dict, plans: list[dict], schema: dict, can_make, database_members) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    uses = PhpUses("Tests").add("PHPUnit\\Framework\\TestCase")
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
        reads = any(item["value"]["kind"] in ("lookup", "children") for item in plan["read"])
        writes = plan["write"] is not None and not _has_todo(plan["write"])
        write_uow = writes and any(item["value"]["kind"] == "lookup" for item in plan["write"])
        klass = conversions_class(info)
        uses.add(class_name(conversions_namespace(context, info), klass))
        reader = f"{_lower_first(names['source'])}Of"
        if dtos and info["name"] not in readers:
            uses.add(
                class_name(namespace_of(context, info, "dtos"), names["source"]),
                class_name(namespace_of(context, info, "entity"), info["entity"]),
            )
            readers[info["name"]] = [
                "    /** The row as the service returns it. */",
                f"    private static function {reader}({info['entity']} $entity): {names['source']}",
                "    {",
                f"        return new {names['source']}(",
                *(
                    f"            {column['field']}: {access('$entity', column['prop'])},"
                    for column in read_columns(info)
                ),
                "        );",
                "    }",
            ]
        row = f"self::{reader}($row)" if dtos else "$row"
        body = [
            "$uow = $this->uow;",
            f"$row = Factories::add{info['entity']}($uow, 1);",
            f"$model = {klass}::{names['read']}({row}{', $uow' if reads else ''});",
        ]
        if writes:
            body.append(f"$values = {klass}::{names['write']}($model{', $uow' if write_uow else ''});")
            for item in plan["write"]:
                column = column_of(info, item["column"])
                given = f"$values->{column['field']}" if dtos else access("$values", column["prop"])
                body.append(f"self::assertEquals({access('$row', column['prop'])}, {given});")
        else:
            body.append("self::assertNotNull($model);")
        method = f"testReads{plan['model']}AndWritesItBack" if writes else f"testReads{plan['model']}"
        tests.append([f"    public function {method}(): void", "    {", *(f"        {line}" for line in body), "    }"])
    if not tests:
        return None
    if memory:
        uses.add(root_class(context, "MemoryUnitOfWork"))
        members = [
            "    private MemoryUnitOfWork $uow;",
            "",
            "    protected function setUp(): void",
            "    {",
            "        $this->uow = new MemoryUnitOfWork();",
            "    }",
        ]
    else:
        members = database_members(uses)
    return test_file(
        "ConversionTest",
        uses,
        [
            "/** Tests of the conversions between the application models and the tables. */",
            "final class ConversionTest extends TestCase",
            "{",
            *members,
            *[line for test in tests for line in ("", *test)],
            *[line for reader in readers.values() for line in ("", *reader)],
            "}",
        ],
    )


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
