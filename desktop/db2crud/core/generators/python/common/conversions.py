"""The conversions between the application models and the tables (conversions/plan.py), written in Python: per table,
a function that turns a model into what the service takes (its create DTO, or the entity) and one that turns what it
returns into the model. Lookups go through the repositories of the unit of work; Mapper's transformations are written
as plain expressions; what the plan leaves to the user is a `# TODO:` with the reason. Mirrors
web/src/core/generators/python/common/conversions.ts.

The model classes are imported from `settings.modelsModule`; with `modelsSource: copy` that module is written into
the project (`models_file`) as dataclasses, so the project runs on its own."""

import re

from ....conversions.plan import has_todo, lossy, without_hidden
from ....matching.names import fields_of
from ....schema.documents import nested_fields
from ...types import lines
from ..python import Imports, py_literal, snake_name
from .context import aw, def_, find_info, module_of, path_of, query, query_name
from .dtos import create_dto, read_dto
from .tests import can_make

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def field_attr(name: str) -> str:
    """The attribute of a model field: its name, or its snake form when the name is not an identifier."""
    return name if _IDENTIFIER.match(name) else snake_name(name)


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


def conversion_names(context: dict, plan: dict) -> dict:
    """The Python names of a plan: its functions, the classes they take and return, and the name the model is
    imported as (`ProductModel` when the model is named like the entity or a DTO it is converted to)."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    model = f"{plan['model']}Model" if plan["model"] in (info["entity"], target, source) else plan["model"]
    imported = plan["model"] if model == plan["model"] else f"{plan['model']} as {model}"
    snake = snake_name(model)
    return {
        "write": f"{snake}_to_{snake_name(target)}",
        "read": f"{snake_name(source)}_to_{snake}",
        "target": target,
        "source": source,
        "model": model,
        "imported": imported,
    }


def conversions_module(context: dict, info: dict) -> str:
    """Module of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"app.{info['module']}.conversions"
    return f"app.conversions.{info['module']}"


# Types of the models

_PRIMITIVES = {
    "string": ("str", None),
    "integer": ("int", None),
    "float": ("float", None),
    "decimal": ("Decimal", ("decimal", "Decimal")),
    "boolean": ("bool", None),
    "date": ("date", ("datetime", "date")),
    "datetime": ("datetime", ("datetime", "datetime")),
    "time": ("time", ("datetime", "time")),
    "duration": ("timedelta", ("datetime", "timedelta")),
    "uuid": ("UUID", ("uuid", "UUID")),
    "binary": ("bytes", None),
}


def _model_type(type_ref: dict, imports: Imports) -> str:
    kind = type_ref["kind"]
    if kind == "primitive":
        found = _PRIMITIVES.get(type_ref["name"])
        if found is None:
            imports.from_("typing", "Any")
            return "Any"
        if found[1]:
            imports.from_(*found[1])
        return found[0]
    if kind == "array":
        return f"list[{_model_type(type_ref['items'], imports)}]"
    if kind == "map":
        return f"dict[{_model_type(type_ref['key'], imports)}, {_model_type(type_ref['value'], imports)}]"
    if kind in ("model", "enum"):
        return type_ref["name"]
    imports.from_("typing", "Any")
    return "Any"


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


def models_file(schema: dict, plans: list[dict], path: str) -> dict:
    """The copy of the application models the conversions use, as dataclasses: at `settings.modelsModule`, or, when
    they are imported from the user's module, at tests/application_models.py for the tests only."""
    imports = Imports().annotations()
    models, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    if models:
        imports.from_("dataclasses", "dataclass")
    if enums:
        imports.from_("enum", "Enum")

    def field(item: dict) -> str:
        type_text = _model_type(item["type"], imports)
        optional = item.get("optional") or item.get("nullable")
        return f"    {field_attr(item['name'])}: {type_text}{' | None = None' if optional else ''}"

    enum_blocks = [
        lines(
            f"class {item['name']}(str, Enum):",
            *(
                f"    {field_attr(value['name']).upper()} = "
                f"{py_literal(str(value['value'] if value.get('value') is not None else value['name']))}"
                for value in item["values"]
            ),
        )
        for item in enums
    ]
    model_blocks = []
    for model in models:
        fields = [field(item) for item in model["fields"]]
        # Fields without a default first: a dataclass refuses them after one with a default
        ordered = [item for item in fields if " = " not in item] + [item for item in fields if " = " in item]
        bases = f"({', '.join(model['extends'])})" if model.get("extends") else ""
        model_blocks.append(
            lines(
                "@dataclass(kw_only=True)",
                f"class {model['name']}{bases}:",
                f'    """{model["name"]}, as the application has it."""',
                *(["", *ordered] if ordered else ["    pass"]),
            )
        )
    content = lines(
        '"""The application models the conversions use: a copy of the classes DB2CRUD read."""',
        "",
        imports.write("app"),
        *[line for block in [*enum_blocks, *model_blocks] for line in ("", "", block)],
        "",
    )
    return {"path": path, "content": content}


def tests_package(context: dict) -> dict:
    """tests/__init__.py when the models are imported: without the user's module (the project on its own), the tests
    take the copy in its place, so they run anywhere and use the real classes inside the application."""
    module = py_literal(context["settings"]["modelsModule"])
    content = lines(
        '"""The tests. The application models come from your module; without it, they are the copy DB2CRUD read."""',
        "",
        "import importlib",
        "import sys",
        "",
        "try:",
        f"    importlib.import_module({module})",
        "except ModuleNotFoundError:",
        f'    sys.modules[{module}] = importlib.import_module("tests.application_models")',
        "",
    )
    return {"path": "tests/__init__.py", "content": content}


# Expressions


def _article(name: str) -> str:
    """`A Customer`, `An Order`."""
    return f"{'An' if re.match(r'[AEIOU]', name, re.IGNORECASE) else 'A'} {name}"


def _access(root: str, path: list[str]) -> str:
    return ".".join([root, *(field_attr(part) for part in path)])


_WHY = {
    "pending": "the matching waits for review",
    "noField": "no field of the model gives it",
    "oneWay": "Mapper's relation only goes the other way",
    "unsupported": "DB2CRUD does not write this conversion",
    "hidden": "the service never returns it",
}


def _todo_comment(todo: dict, attr: str) -> str:
    detail = f" ({todo['detail']})" if todo.get("detail") else ""
    return f"# TODO: {attr}: {_WHY[todo['reason']]}{detail}"


def _plain(value: str) -> str:
    """`Enum` members are written by their value."""
    return f"_plain({value})"


def _transformed(transform: dict, values: list[str], to_integer: bool, imports: Imports) -> str:
    """A Mapper transformation of the given values (forward), or its inverse of one value."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        return f"{py_literal(transform['separator'])}.join(str(part) for part in ({', '.join(values)}))"
    if kind == "split":
        part = transform["part"]
        parts = f"str({value}).split({py_literal(transform['separator'])}{', 1' if part == 'rest' else ''})"
        if part == "last":
            return f"{parts}[-1]"
        if part == "rest":
            return f'({parts} + [""])[1]'
        return f'({parts} + [""] * {part + 1})[{part}]'
    if kind == "constant":
        return py_literal(transform["value"])
    if kind == "boolean":
        true_values = transform["trueValues"]
        items = ", ".join(py_literal(item) for item in true_values)
        return f"{_plain(value)} in ({items}{',' if len(true_values) == 1 else ''})"
    if kind == "enum":
        pairs = ", ".join(f"{py_literal(pair['from'])}: {py_literal(pair['to'])}" for pair in transform["pairs"])
        if transform.get("fallback") is not None:
            return f"{{{pairs}}}.get({_plain(value)}, {py_literal(transform['fallback'])})"
        return f"{{{pairs}}}[{_plain(value)}]"
    if kind == "epoch":
        # From a number: a date and time; from a date and time: a number
        imports.from_("datetime", "datetime", "timezone")
        milliseconds = transform["unit"] == "milliseconds"
        if to_integer:
            return f"int({value}.timestamp(){' * 1000' if milliseconds else ''})"
        return f"datetime.fromtimestamp({value}{' / 1000' if milliseconds else ''}, tz=timezone.utc)"
    if kind == "arithmetic":
        result = f"{value} {transform['operator']} {py_literal(transform['operand'])}"
        return f"round({result})" if to_integer else result
    return "None"


_INVERSE = {"*": "/", "/": "*", "+": "-", "-": "+"}


def _inverse(transform: dict) -> dict:
    """The transformation that undoes an invertible one."""
    if transform["kind"] == "arithmetic":
        return {**transform, "operator": _INVERSE[transform["operator"]]}
    if transform["kind"] == "enum":
        return {"kind": "enum", "pairs": [{"from": pair["to"], "to": pair["from"]} for pair in transform["pairs"]]}
    return transform


def _column_attr(info: dict, column: str) -> str:
    found = next((item for item in info["columns"] if item["column"]["name"] == column), None)
    return found["attr"] if found else column


# Nested documents. A nested is {context, info, schema, plan, imports, functions: those written so far}


def _to_document(expression: str, type_ref: dict, kept: dict, imports: Imports) -> str:
    """A value of a model as a document database keeps it: `expression` itself when nothing changes."""
    if type_ref["kind"] == "array":
        if kept["kind"] != "array":
            return expression
        item = _to_document("item", type_ref["items"], kept["items"], imports)
        return expression if item == "item" else f"[{item} for item in {expression}]"
    if type_ref["kind"] == "enum":
        return _plain(expression)
    if type_ref["kind"] != "primitive":
        return expression
    name = type_ref["name"]
    kind = kept["kind"]
    if kind in ("text", "enum", "date", "time"):
        if name in ("date", "time", "datetime"):
            return f"{expression}.isoformat()"
        return expression if name in ("string", "any") else f"str({expression})"
    if kind == "uuid":
        if name != "string":
            return expression
        imports.from_("uuid", "UUID")
        return f"UUID({expression})"
    if kind == "decimal":
        if name in ("decimal", "any"):
            return expression
        imports.from_("decimal", "Decimal")
        return f"Decimal(str({expression}))" if name == "float" else f"Decimal({expression})"
    if kind == "float":
        return expression if name in ("float", "any") else f"float({expression})"
    if kind == "datetime":
        if name == "date":
            imports.from_("datetime", "datetime", "timezone")
            return f"datetime({expression}.year, {expression}.month, {expression}.day, tzinfo=timezone.utc)"
        if name != "string":
            return expression
        imports.from_("datetime", "datetime")
        return f"datetime.fromisoformat({expression})"
    return expression


def _from_document(expression: str, kept: dict, type_ref: dict, context: dict, imports: Imports) -> str:
    """A value of a document as a model has it: `expression` itself when nothing changes."""
    if type_ref["kind"] == "array":
        if kept["kind"] != "array":
            return expression
        item = _from_document("item", kept["items"], type_ref["items"], context, imports)
        return expression if item == "item" else f"[{item} for item in {expression}]"
    if type_ref["kind"] == "enum":
        imports.from_(context["settings"]["modelsModule"], type_ref["name"])
        return f"{type_ref['name']}({expression})"
    if type_ref["kind"] != "primitive":
        return expression
    kind = kept["kind"]
    textual = kind in ("text", "enum", "date", "time")
    name = type_ref["name"]
    if name == "string":
        if kind == "datetime":
            return f"{expression}.isoformat()"
        return f"str({expression})" if kind in ("uuid", "decimal") else expression
    if name == "integer":
        return f"int({expression})" if kind in ("float", "decimal") else expression
    if name == "float":
        return f"float({expression})" if kind == "decimal" else expression
    if name == "decimal":
        if kind == "decimal":
            return expression
        imports.from_("decimal", "Decimal")
        return f"Decimal(str({expression}))"
    if name == "uuid":
        if not textual:
            return expression
        imports.from_("uuid", "UUID")
        return f"UUID({expression})"
    if name in ("date", "time", "datetime"):
        if name == "date" and kind == "datetime":
            return f"{expression}.date()"
        if not textual:
            return expression
        imports.from_("datetime", name)
        return f"{name}.fromisoformat({expression})"
    return expression


def _when_present(expression: str, converted: str, missing: bool, otherwise: str = "None") -> str:
    """A value that may be missing, converted when it is there; `otherwise` is what a missing one is."""
    if not missing or (converted == expression and otherwise == "None"):
        return converted
    return f"{converted} if {expression} is not None else {otherwise}"


def _may_miss(field: dict | None) -> bool:
    return field is None or bool(field.get("optional") or field.get("nullable"))


def _absent(field: dict) -> str:
    """A missing value of a document, as a field of a model has it."""
    return "[]" if not _may_miss(field) and field["type"]["kind"] == "array" else "None"


def _model_fields(nested: dict, name: str) -> list[dict]:
    model = next((item for item in nested["schema"]["models"] if item["name"] == name), None)
    return fields_of(model, nested["schema"]) if model else []


def _nested_model(nested: dict, name: str) -> str:
    """The name a nested model is imported as: another one when the entity or a DTO has it."""
    names = conversion_names(nested["context"], nested["plan"])
    # The model of the collection itself, when a document inside it is one too
    if name == nested["plan"]["model"]:
        return names["model"]
    local = f"{name}Model" if name in (nested["info"]["entity"], names["target"], names["source"]) else name
    imported = name if local == name else f"{name} as {local}"
    nested["imports"].from_(nested["context"]["settings"]["modelsModule"], imported)
    return local


def _function_name(nested: dict, path: list[str], end: str) -> str:
    return f"_{snake_name(' '.join([nested['plan']['model'], *path, end]))}"


def _call_for(name: str, many: bool, expression: str) -> str:
    return f"[{name}(item) for item in {expression}]" if many else f"{name}({expression})"


def _inner_column(kept: dict, name: str) -> dict:
    return next(item for item in nested_fields(kept) if item["name"] == name)


def _write_document(nested: dict, value: dict, kept: dict, path: list[str]) -> str:
    """Writes the function that gives a nested document from its model, and those inside it; gives its name."""
    name = _function_name(nested, path, "to document")
    fields = _model_fields(nested, value["model"])
    entries = []
    for item in value["values"]:
        column = _inner_column(kept, item["column"])
        inner = item["value"]
        if inner["kind"] == "todo":
            entries.append(_todo_comment(inner, column["name"]))
            continue
        if inner["kind"] not in ("field", "document"):
            continue
        read = _access("value", inner["path"])
        field = next(candidate for candidate in fields if candidate["name"] == inner["path"][0])
        if inner["kind"] == "document":
            function = _write_document(nested, inner, column["type"], [*path, column["name"]])
            converted = _call_for(function, inner["many"], read)
        else:
            converted = _to_document(read, field["type"], column["type"], nested["imports"])
        entries.append(f"{py_literal(column['name'])}: {_when_present(read, converted, _may_miss(field))},")
    nested["imports"].from_("typing", "Any")
    collection = nested["info"]["name"]
    nested["functions"].append(
        lines(
            f"def {name}(value: {_nested_model(nested, value['model'])}) -> Any:",
            f'    """{_article(value["model"])} as the {collection} collection keeps it; what is missing is left out."""',
            bool(value["unused"]) and f"    # Not stored: {', '.join(value['unused'])}",
            "    document = {",
            *(f"        {entry}" for entry in entries),
            "    }",
            "    return {key: item for key, item in document.items() if item is not None}",
        )
    )
    return name


def _read_document(nested: dict, value: dict, kept: dict, path: list[str]) -> str:
    """Writes the function that gives a model from its nested document, and those inside it; gives its name."""
    name = _function_name(nested, path, "from document")
    fields = _model_fields(nested, value["model"])
    args = []
    for item in value["values"]:
        field = next(candidate for candidate in fields if candidate["name"] == item["field"])
        attr = field_attr(field["name"])
        inner = item["value"]
        if inner["kind"] == "todo":
            args.extend([_todo_comment(inner, attr), f"{attr}=None,"])
            continue
        if inner["kind"] not in ("column", "document"):
            continue
        column = _inner_column(kept, inner["column"])
        # A field the document may not have
        missing = column["nullable"] or column.get("default") is not None
        key = py_literal(column["name"])
        read = f"value.get({key})" if missing else f"value[{key}]"
        if inner["kind"] == "document":
            function = _read_document(nested, inner, column["type"], [*path, column["name"]])
            converted = _call_for(function, inner["many"], read)
        else:
            converted = _from_document(read, column["type"], field["type"], nested["context"], nested["imports"])
        args.append(f"{attr}={_when_present(read, converted, missing, _absent(field))},")
    nested["imports"].from_("typing", "Any")
    model = _nested_model(nested, value["model"])
    article = _article(value["model"]).split(" ")[0].lower()
    nested["functions"].append(
        lines(
            f"def {name}(value: Any) -> {model}:",
            f'    """A document of the {nested["info"]["name"]} collection as {article} {value["model"]}."""',
            f"    return {model}(",
            *(f"        {arg}" for arg in args),
            "    )",
        )
    )
    return name


def _write_expression(
    context: dict, info: dict, column: str, value: dict, body: dict, imports: Imports, nested: dict
) -> str | None:
    """The statements before the result, and the value of a column written from the model."""
    column_info = next((item for item in info["columns"] if item["column"]["name"] == column), None)
    to_integer = column_info is not None and column_info["column"]["type"]["kind"] == "integer"
    kind = value["kind"]
    if kind in ("field", "document"):
        read = _access("model", value["path"])
        if not context["orm"].get("documents") or column_info is None:
            return read
        fields = _model_fields(nested, nested["plan"]["model"])
        field = next((item for item in fields if item["name"] == value["path"][0]), None)
        column_type = column_info["column"]["type"]
        if kind == "document":
            name = _write_document(nested, value, column_type, [column_info["attr"]])
            return _when_present(read, _call_for(name, value["many"], read), _may_miss(field))
        if field is None:
            return read
        return _when_present(read, _to_document(read, field["type"], column_type, imports), _may_miss(field))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        if not other or not finder:
            return None
        name = other["module"]
        given = _access("model", value["path"])
        imports.from_("app.errors", "NotFoundError")
        body["uow"] = True
        body["lines"].extend(
            [
                f"{name} = {aw(context)}uow.{other['attr']}.{query_name(context, finder)}({given})",
                f"if {name} is None:",
                f"    raise NotFoundError({py_literal(other['entity'])}, {given})",
            ]
        )
        return f"{name}.{_column_attr(other, value['key'])}"
    if kind == "mapper":
        sources = [_access("model", path) for path in value["sources"]]
        return _transformed(value["transform"], sources, to_integer, imports)
    return _transformed(_inverse(value["transform"]), [_access("model", value["path"])], to_integer, imports)


def _read_expression(
    context: dict, info: dict, field: dict | None, value: dict, body: dict, imports: Imports, nested: dict
) -> str | None:
    field_type = field["type"] if field else None
    to_integer = field_type is not None and field_type["kind"] == "primitive" and field_type["name"] == "integer"

    def enum_of(expression: str) -> str:
        if field_type is None or field_type["kind"] != "enum":
            return expression
        imports.from_(context["settings"]["modelsModule"], field_type["name"])
        return f"{field_type['name']}({expression})"

    kind = value["kind"]
    if kind in ("column", "document"):
        attr = _column_attr(info, value["column"])
        read = f"row.{attr}"
        own = next((item["column"] for item in info["columns"] if item["column"]["name"] == value["column"]), None)
        if not context["orm"].get("documents") or own is None or field is None:
            return read
        if kind == "document":
            converted = _call_for(_read_document(nested, value, own["type"], [attr]), value["many"], read)
        else:
            converted = _from_document(read, own["type"], field["type"], context, imports)
        return _when_present(read, converted, own["nullable"], _absent(field))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = (query(other, "getByKey") or query(other, "findByUnique", [value["key"]])) if other else None
        if not other or not finder:
            return None
        name = other["module"]
        body["uow"] = True
        row = f"row.{_column_attr(info, value['column'])}"
        body["lines"].append(f"{name} = {aw(context)}uow.{other['attr']}.{query_name(context, finder)}({row})")
        return f"{name}.{_column_attr(other, value['by'])} if {name} is not None else None"
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return None
        body["uow"] = True
        item = _column_attr(other, value["value"])
        rows = f"{aw(context)}uow.{other['attr']}.{query_name(context, lister)}(row.{_column_attr(info, value['key'])})"
        return f"[item.{item} for item in {rows}]"
    if kind == "mapper":
        columns = [f"row.{_column_attr(info, column)}" for column in value["columns"]]
        return enum_of(_transformed(value["transform"], columns, to_integer, imports))
    row = f"row.{_column_attr(info, value['column'])}"
    return enum_of(_transformed(_inverse(value["transform"]), [row], to_integer, imports))


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The file of the conversions of one table: one function per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    imports = Imports().annotations()
    functions: list[str] = []
    uses_uow = False
    uses_plain = False
    for plan in plans:
        nested = {
            "context": context,
            "info": info,
            "schema": schema,
            "plan": plan,
            "imports": imports,
            "functions": functions,
        }
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        dtos = _uses_dtos(context, info)
        imports.from_(context["settings"]["modelsModule"], names["imported"])
        if dtos:
            imports.from_(module_of(context, info, "dtos"), names["target"])
        else:
            imports.from_(module_of(context, info, "entity"), info["entity"])
        if plan["write"] is not None:
            body = {"lines": [], "uow": False}
            args: list[str] = []
            for item in plan["write"]:
                attr = _column_attr(info, item["column"])
                if item["value"]["kind"] == "todo":
                    args.append(_todo_comment(item["value"], attr))
                    continue
                expression = _write_expression(context, info, item["column"], item["value"], body, imports, nested)
                if expression is None:
                    args.append(f"# TODO: {attr}: no repository query finds the row it names")
                else:
                    args.append(f"{attr}={expression},")
            if any("_plain(" in arg for arg in args):
                uses_plain = True
            uses_uow = uses_uow or body["uow"]
            params = f"model: {names['model']}, uow: UnitOfWork" if body["uow"] else f"model: {names['model']}"
            functions.append(
                lines(
                    f"{def_(context) if body['uow'] else 'def'} {names['write']}({params}) -> {names['target']}:",
                    f'    """{_article(plan["model"])} as the {info["name"]} table takes it."""',
                    *(f"    {line}" for line in body["lines"]),
                    f"    return {names['target']}(",
                    *(f"        {arg}" for arg in args),
                    "    )",
                )
            )
        if plan["read"] is not None:
            body = {"lines": [], "uow": False}
            args = []
            for item in plan["read"]:
                field = (
                    next((candidate for candidate in model["fields"] if candidate["name"] == item["field"]), None)
                    if model
                    else None
                )
                attr = field_attr(item["field"])
                if item["value"]["kind"] == "todo":
                    args.extend([_todo_comment(item["value"], attr), f"{attr}=None,"])
                    continue
                expression = _read_expression(context, info, field, item["value"], body, imports, nested)
                if expression is None:
                    args.append(f"{attr}=None,  # TODO: no repository query reads it")
                else:
                    args.append(f"{attr}={expression},")
            if any("_plain(" in arg for arg in args):
                uses_plain = True
            uses_uow = uses_uow or body["uow"]
            params = f"row: {names['source']}, uow: UnitOfWork" if body["uow"] else f"row: {names['source']}"
            if dtos:
                imports.from_(module_of(context, info, "dtos"), names["source"])
            article = _article(plan["model"]).split(" ")[0].lower()
            functions.append(
                lines(
                    f"{def_(context) if body['uow'] else 'def'} {names['read']}({params}) -> {names['model']}:",
                    f'    """A row of the {info["name"]} table as {article} {plan["model"]}."""',
                    *(f"    {line}" for line in body["lines"]),
                    f"    return {names['model']}(",
                    *(f"        {arg}" for arg in args),
                    "    )",
                )
            )
    if any("_plain(" in item for item in functions):
        uses_plain = True
    if uses_uow:
        imports.from_("app.unit_of_work", "UnitOfWork")
    if uses_plain:
        imports.from_("typing", "Any")
    helper = (
        [
            "",
            "",
            "def _plain(value: Any) -> Any:",
            '    """The value of an enum member, or the value itself."""',
            '    return getattr(value, "value", value)',
        ]
        if uses_plain
        else []
    )
    content = lines(
        f'"""Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        ' returns."""',
        "",
        imports.write("app"),
        *helper,
        *[line for block in functions for line in ("", "", block)],
        "",
    )
    return {"path": path_of(conversions_module(context, info)), "content": content}


def conversion_test_file(context: dict, plans: list[dict], schema: dict | None) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and each field taken from a
    column holds its value; a model that goes both ways and leaves nothing to the user is written back, and every
    value it gives is the row's (lookups and Mapper's lossless transformations included)."""
    imports = Imports()
    memory = context["settings"]["memoryRepositories"]
    fixture = "memory_uow: MemoryUnitOfWork" if memory else context["orm"]["databaseFixture"]
    uow = fixture.split(":")[0]
    is_async = context["async"]
    documents = bool(context["orm"].get("documents"))
    blocks: list[str] = []
    for plan in plans:
        info = find_info(context, plan["table"])
        if not info or plan["read"] is None or has_todo(plan["read"]) or not can_make(context, info):
            continue
        names = conversion_names(context, plan)
        reads = any(item["value"]["kind"] in ("lookup", "children") for item in plan["read"])
        writes = plan["write"] is not None and not has_todo(plan["write"])
        write_uow = writes and any(item["value"]["kind"] == "lookup" for item in plan["write"])
        imports.from_(conversions_module(context, info), names["read"], *([names["write"]] if writes else []))
        imports.from_("tests.factories", f"add_{info['module']}")

        def await_(uses: bool) -> str:
            return "await " if uses and is_async else ""

        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None) if schema else None
        fields = fields_of(model, schema) if model else []
        types = {item["column"]["name"]: item["column"]["type"] for item in info["columns"]}

        def changes(item: dict, fields: list[dict] = fields, types: dict = types) -> bool:
            # A value the model keeps with less detail is not written back as it was
            return documents and schema is not None and lossy(item["value"], types[item["column"]], fields, schema)

        def same(name: str, column: str, fields: list[dict] = fields, types: dict = types) -> bool:
            # Nor is one converted to another type equal to that of the row
            field = next((item for item in fields if item["name"] == name), None)
            if not documents or field is None:
                return True
            return _from_document("x", types[column], field["type"], context, Imports()) == "x"

        body = [
            f"row = {aw(context)}add_{info['module']}({uow})",
            f"model = {await_(reads)}{names['read']}(row{f', {uow}' if reads else ''})",
            *(
                f"assert model.{field_attr(item['field'])} == row.{_column_attr(info, item['value']['column'])}"
                for item in plan["read"]
                if item["value"]["kind"] == "column" and same(item["field"], item["value"]["column"])
            ),
        ]
        if writes:
            body.append(f"values = {await_(write_uow)}{names['write']}(model{f', {uow}' if write_uow else ''})")
            body.extend(
                f"assert values.{_column_attr(info, item['column'])} == row.{_column_attr(info, item['column'])}"
                for item in plan["write"]
                if not changes(item)
            )
        named = _article(plan["model"])
        named = "a" + named[1:] if named.startswith("A") else named
        doc = (
            f"A row read as {named} and written back gives the same values." if writes else f"A row is read as {named}."
        )
        blocks.append(
            lines(
                f"{def_(context)} test_{snake_name(plan['model'])}_{'goes_both_ways' if writes else 'is_read'}"
                f"({fixture}) -> None:",
                f'    """{doc}"""',
                *(f"    {line}" for line in body),
            )
        )
    if not blocks:
        return None
    imports.from_("app.unit_of_work", fixture.split(": ")[1])
    suffix = " (asynchronous: pytest-asyncio runs every test function)" if is_async else ""
    content = lines(
        f'"""Tests of the conversions between the application models and the tables{suffix}."""',
        "",
        imports.write("app"),
        *[line for block in blocks for line in ("", "", block)],
        "",
    )
    return {"path": "tests/test_conversions.py", "content": content}


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion files of a project and, when they are copied, the module of the models."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    if context["settings"]["modelsSource"] == "copy":
        files.append(models_file(schema, plans, path_of(context["settings"]["modelsModule"])))
    elif context["settings"]["tests"] != "none":
        files.append(models_file(schema, plans, "tests/application_models.py"))
    return files
