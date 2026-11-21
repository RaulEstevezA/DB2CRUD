"""The conversions between the application models and the tables (conversions/plan.py), written in TypeScript: per
table, a function that turns a model into what the service takes (its create DTO, or the entity) and one that turns
what it returns into the model. Values are converted between the model's type and the column's (`number` and a
decimal kept as text, `Date` and text, `undefined` and `null`), so the project type-checks; lookups go through the
repositories of the unit of work; Mapper's transformations are plain expressions; what the plan leaves to the user is
a `// TODO:` with the reason. Mirrors web/src/core/generators/typescript/common/conversions.ts.

The models are imported as types only: copied into `src/application-models.ts`, or, with `modelsSource: import`, from
the user's module (`settings.modelsModule`), declared for the project on its own in `src/application-models.d.ts` (to
delete inside the application)."""

import re

from ....conversions.plan import without_hidden
from ....js import js_string
from ...types import lines
from ..typescript import TsImports, member_name, ts_literal
from .context import column_of, find_info, module_of, path_of, query, query_name
from .dtos import create_dto, read_dto

_IDENTIFIER = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

COPY_MODULE = "src/application-models"
"""The module of the copy of the models in the project."""
DECLARATION_PATH = "src/application-models.d.ts"
"""The declaration that stands in for the user's module when the models are imported."""


def field_prop(name: str) -> str:
    """The property of a model field: its name, or its camelCase form when the name is not an identifier."""
    return name if _IDENTIFIER.match(name) else member_name(name)


def _literal(value) -> str:
    """tsLiteral of any literal (booleans as JavaScript writes them)."""
    return ts_literal(value) if value is None or isinstance(value, str) else js_string(value)


def models_import(context: dict) -> str:
    """The module the conversions import the models from: the copy, or the user's (dots as slashes)."""
    settings = context["settings"]
    return COPY_MODULE if settings["modelsSource"] == "copy" else settings["modelsModule"].replace(".", "/")


def _uses_dtos(context: dict, info: dict) -> bool:
    settings = context["settings"]
    return (
        settings["services"]
        and settings["serviceTypes"] == "dtos"
        and info["service"] is not None
        and info["role"] == "entity"
    )


def _lower_first(text: str) -> str:
    return text[:1].lower() + text[1:]


def service_plans(context: dict, plans: list[dict]) -> list[dict]:
    """The plans as the services serve them: a read DTO leaves out the hidden columns, so no field is read from them."""
    result = []
    for plan in plans:
        info = find_info(context, plan["table"])
        result.append(without_hidden(plan, info["hidden"]) if info and _uses_dtos(context, info) else plan)
    return result


def conversion_names(context: dict, plan: dict) -> dict:
    """The names of a plan: its functions, the types they take and return, and the name the model is imported as."""
    info = find_info(context, plan["table"])
    dtos = _uses_dtos(context, info)
    target = create_dto(info) if dtos else info["entity"]
    source = read_dto(info) if dtos else info["entity"]
    model = f"{plan['model']}Model" if plan["model"] in (info["entity"], target, source) else plan["model"]
    imported = plan["model"] if model == plan["model"] else f"{plan['model']} as {model}"
    return {
        "write": f"{_lower_first(model)}To{target}",
        "read": f"{_lower_first(source)}To{model}",
        "target": target,
        "source": source,
        "model": model,
        "imported": imported,
    }


def conversions_module(context: dict, info: dict) -> str:
    """Module of the conversions of a table, by architecture."""
    if context["settings"]["architecture"] == "table":
        return f"src/{info['file']}/conversions"
    return f"src/conversions/{info['file']}"


# Types


def _model_ts(type_ref: dict) -> str:
    """The TypeScript type of a model field."""
    kind = type_ref["kind"]
    if kind == "primitive":
        name = type_ref["name"]
        if name in ("integer", "float", "decimal", "duration"):
            return "number"
        if name == "boolean":
            return "boolean"
        if name == "datetime":
            return "Date"
        if name == "binary":
            return "Buffer"
        if name == "any":
            return "unknown"
        return "string"
    if kind == "array":
        return f"{_model_ts(type_ref['items'])}[]"
    if kind == "map":
        return f"Record<string, {_model_ts(type_ref['value'])}>"
    if kind in ("model", "enum"):
        return type_ref["name"]
    return "unknown"


_PLAIN = {"string", "number", "boolean", "Date", "Buffer", "unknown"}


def _convert(expression: str, source: str, target: str) -> str:
    """A value of one type as another: numbers and text, dates and text; enums are text."""
    if source == target or target == "unknown":
        return expression
    if target not in _PLAIN:
        return f"({expression} as {target})" if source == "string" else expression
    if source not in _PLAIN:
        return f"String({expression})" if target == "string" else expression
    if target == "string":
        return f"{expression}.toISOString()" if source == "Date" else f"String({expression})"
    if target == "number":
        return f"Number({expression})"
    if target == "Date":
        return f"new Date({expression} as string | number)"
    return expression


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


def _enum_member(name: str) -> str:
    member = member_name(name)
    return member[:1].upper() + member[1:]


def models_file(schema: dict, plans: list[dict], declared: str | None) -> dict:
    """The copy of the application models the conversions use, as interfaces and string enums: a module of the
    project, or the declaration of the user's module (`declare`) when they are imported."""
    models, enums = _closure(schema, _unique([plan["model"] for plan in plans]))
    blocks = [
        lines(
            f"export enum {item['name']} {{",
            *(
                f"  {_enum_member(value['name'])} = "
                f"{ts_literal(js_string(value['value'] if value.get('value') is not None else value['name']))},"
                for value in item["values"]
            ),
            "}",
        )
        for item in enums
    ]
    for model in models:
        extends = f" extends {', '.join(model['extends'])}" if model.get("extends") else ""
        blocks.append(
            lines(
                f"/** {model['name']}, as the application has it. */",
                f"export interface {model['name']}{extends} {{",
                *(
                    f"  {field_prop(field['name'])}{'?' if field.get('optional') else ''}: "
                    f"{_model_ts(field['type'])}{' | null' if field.get('nullable') else ''}"
                    for field in model["fields"]
                ),
                "}",
            )
        )
    if declared is None:
        return {
            "path": path_of(COPY_MODULE),
            "content": lines(
                "/** The application models the conversions use: a copy of the classes DB2CRUD read. */",
                *[line for block in blocks for line in ("", block)],
                "",
            ),
        }
    body: list[str] = []
    for index, block in enumerate(blocks):
        if index > 0:
            body.append("")
        body.extend(f"  {line}" for line in block.split("\n"))
    return {
        "path": DECLARATION_PATH,
        "content": lines(
            f"/** The application models, as the project imports them from `{declared}`: a copy of the classes"
            " DB2CRUD read, so it type-checks on its own. Delete it inside the application. */",
            f"declare module '{declared}' {{",
            *body,
            "}",
            "",
        ),
    }


# Expressions


def _article(name: str) -> str:
    """`A Customer`, `An Order`."""
    return f"{'An' if re.match(r'[AEIOU]', name, re.IGNORECASE) else 'A'} {name}"


_WHY = {
    "pending": "the matching waits for review",
    "noField": "no field of the model gives it",
    "oneWay": "Mapper's relation only goes the other way",
    "unsupported": "DB2CRUD does not write this conversion",
    "hidden": "the service never returns it",
}


def _todo_comment(todo: dict, prop: str) -> str:
    detail = f" ({todo['detail']})" if todo.get("detail") else ""
    return f"// TODO: {prop}: {_WHY[todo['reason']]}{detail}"


_INVERSE = {"*": "/", "/": "*", "+": "-", "-": "+"}


def _inverse(transform: dict) -> dict:
    """The transformation that undoes an invertible one."""
    if transform["kind"] == "arithmetic":
        return {**transform, "operator": _INVERSE[transform["operator"]]}
    if transform["kind"] == "enum":
        return {"kind": "enum", "pairs": [{"from": pair["to"], "to": pair["from"]} for pair in transform["pairs"]]}
    return transform


def _typed(expression: str, type_text: str) -> dict:
    return {"expression": expression, "type": type_text}


def _transformed(transform: dict, values: list[dict], target: str, body: dict) -> dict:
    """A Mapper transformation of typed values, as an expression of the type it gives."""
    value = values[0]
    kind = transform["kind"]
    if kind == "direct":
        return value
    if kind == "concat":
        items = ", ".join(item["expression"] for item in values)
        return _typed(f"[{items}].map(String).join({ts_literal(transform['separator'])})", "string")
    if kind == "split":
        separator = ts_literal(transform["separator"])
        parts = f"String({value['expression']}).split({separator})"
        part = transform["part"]
        if part == "last":
            return _typed(f"({parts}.at(-1) ?? '')", "string")
        if part == "rest":
            return _typed(f"{parts}.slice(1).join({separator})", "string")
        return _typed(f"({parts}[{part}] ?? '')", "string")
    if kind == "constant":
        constant = transform["value"]
        if constant is None:
            type_text = "unknown"
        elif isinstance(constant, bool):
            type_text = "boolean"
        elif isinstance(constant, str):
            type_text = "string"
        else:
            type_text = "number"
        return _typed(_literal(constant), type_text)
    if kind == "boolean":
        items = ", ".join(ts_literal(item) for item in transform["trueValues"])
        return _typed(f"[{items}].includes(String({value['expression']}))", "boolean")
    if kind == "enum":
        body["pairs"] = True
        pairs = ", ".join(f"{ts_literal(pair['from'])}: {ts_literal(pair['to'])}" for pair in transform["pairs"])
        fallback = f", {ts_literal(transform['fallback'])}" if transform.get("fallback") is not None else ""
        return _typed(f"pair({{ {pairs} }}, {value['expression']}{fallback})", "string")
    if kind == "epoch":
        milliseconds = transform["unit"] == "milliseconds"
        if target in ("number", "string"):
            date = _convert(value["expression"], value["type"], "Date")
            return _typed(f"Math.round({date}.getTime(){'' if milliseconds else ' / 1000'})", "number")
        return _typed(f"new Date(Number({value['expression']}){'' if milliseconds else ' * 1000'})", "Date")
    if kind == "arithmetic":
        operand = _literal(transform["operand"])
        return _typed(f"(Number({value['expression']}) {transform['operator']} {operand})", "number")
    return _typed("undefined", "unknown")


def _write_expression(
    context: dict, column: dict, value: dict, model: dict | None, body: dict, imports: TsImports
) -> str | None:
    """The value of a column written from the model, with the statements it needs before."""

    def field(path: list[str]) -> dict | None:
        if model is None:
            return None
        return next((item for item in model["fields"] if item["name"] == path[0]), None)

    def typed(path: list[str]) -> dict:
        found = field(path)
        type_text = _model_ts(found["type"]) if found and len(path) == 1 else "unknown"
        return _typed(".".join(["model", *(field_prop(part) for part in path)]), type_text)

    integer = column["column"]["type"]["kind"] == "integer"

    def finish(result: dict, path: list[str] | None = None) -> str:
        expression = result["expression"]
        rounded = integer and result["type"] == "number" and re.search(r"[*/]", expression)
        converted = _convert(f"Math.round({expression})" if rounded else expression, result["type"], column["ts"])
        found = field(path) if path else None
        # A field the model may leave out is null in the column
        if found and (found.get("optional") or found.get("nullable")):
            return f"{expression} ?? null" if converted == expression else f"{expression} == null ? null : {converted}"
        return converted

    kind = value["kind"]
    if kind == "field":
        return finish(typed(value["path"]), value["path"])
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = query(other, "findByUnique", [value["by"]]) if other else None
        if not other or not finder:
            return None
        name = member_name(other["entity"])
        given = typed(value["path"])
        imports.from_("src/errors", "NotFoundError")
        body["uow"] = True
        argument = _convert(given["expression"], given["type"], column_of(other, value["by"])["ts"])
        body["lines"].extend(
            [
                f"const {name} = await uow.{other['attr']}.{query_name(context, finder)}({argument})",
                f"if (!{name}) throw new NotFoundError({ts_literal(other['entity'])}, {given['expression']})",
            ]
        )
        return f"{name}.{column_of(other, value['key'])['prop']}"
    if kind == "mapper":
        return finish(_transformed(value["transform"], [typed(path) for path in value["sources"]], column["ts"], body))
    inverse = _transformed(_inverse(value["transform"]), [typed(value["path"])], column["ts"], body)
    return finish(inverse, value["path"])


def _read_expression(
    context: dict, info: dict, field: dict | None, value: dict, body: dict, imports: TsImports
) -> str | None:
    target = _model_ts(field["type"]) if field else "unknown"
    # An enum or a model of the application the value is cast to
    if field and field["type"]["kind"] in ("enum", "model"):
        imports.type(models_import(context), target)

    def typed(name: str) -> dict:
        column = column_of(info, name)
        return _typed(f"row.{column['prop']}", column["ts"])

    # A column that may be null into a field that may only be missing: undefined in the model
    def fit(expression: str, nullable: bool, converted: str) -> str:
        if not nullable:
            return converted
        result = expression if converted == expression else f"{expression} == null ? null : {converted}"
        if field and field.get("nullable"):
            return result
        return f"{expression if result == expression else f'({result})'} ?? undefined"

    kind = value["kind"]
    if kind == "column":
        source = typed(value["column"])
        nullable = column_of(info, value["column"])["column"]["nullable"]
        return fit(source["expression"], nullable, _convert(source["expression"], source["type"], target))
    if kind == "lookup":
        other = find_info(context, value["table"])
        finder = (query(other, "getByKey") or query(other, "findByUnique", [value["key"]])) if other else None
        if not other or not finder:
            return None
        name = member_name(other["entity"])
        own = column_of(info, value["column"])
        nullable = own["column"]["nullable"]
        body["uow"] = True
        guard = f"row.{own['prop']} == null ? undefined : " if nullable else ""
        body["lines"].append(
            f"const {name} = {guard}await uow.{other['attr']}.{query_name(context, finder)}(row.{own['prop']})"
        )
        by = column_of(other, value["by"])
        access = f"{name}{'?' if nullable else '!'}.{by['prop']}"
        return f"{access} ?? undefined" if nullable else _convert(access, by["ts"], target)
    if kind == "children":
        other = find_info(context, value["table"])
        lister = (
            (query(other, "listByParent", [value["by"]]) or query(other, "findAllBy", [value["by"]])) if other else None
        )
        if not other or not lister:
            return None
        body["uow"] = True
        key = column_of(info, value["key"])["prop"]
        item = column_of(other, value["value"])["prop"]
        return f"(await uow.{other['attr']}.{query_name(context, lister)}(row.{key})).map((item) => item.{item})"
    if kind == "mapper":
        result = _transformed(value["transform"], [typed(column) for column in value["columns"]], target, body)
        return _convert(result["expression"], result["type"], target)
    result = _transformed(_inverse(value["transform"]), [typed(value["column"])], target, body)
    return _convert(result["expression"], result["type"], target)


def conversion_file(context: dict, plans: list[dict], schema: dict) -> dict | None:
    """The file of the conversions of one table: one function per direction its models go."""
    info = find_info(context, plans[0]["table"])
    if info is None:
        return None
    module = conversions_module(context, info)
    imports = TsImports(module)
    functions: list[str] = []
    pairs = False
    for plan in plans:
        model = next((item for item in schema["models"] if item["name"] == plan["model"]), None)
        names = conversion_names(context, plan)
        dtos = _uses_dtos(context, info)
        imports.type(models_import(context), names["imported"])
        if plan["write"] is not None:
            body = {"lines": [], "uow": False, "pairs": False}
            props: list[str] = []
            for item in plan["write"]:
                column = column_of(info, item["column"])
                if item["value"]["kind"] == "todo":
                    # The comment stays, and the property keeps the project type-checking until it is filled
                    props.extend(
                        [_todo_comment(item["value"], column["prop"]), f"{column['prop']}: undefined as never,"]
                    )
                    continue
                expression = _write_expression(context, column, item["value"], model, body, imports)
                props.append(
                    f"{column['prop']}: undefined as never, // TODO: no repository query finds the row it names"
                    if expression is None
                    else f"{column['prop']}: {expression},"
                )
            pairs = pairs or body["pairs"]
            if body["uow"]:
                imports.type("src/unit-of-work", "UnitOfWork")
            if dtos:
                imports.type(module_of(context, info, "dtos"), names["target"])
            else:
                imports.from_(module_of(context, info, "entity"), info["entity"])
            if dtos:
                result = ["  return {", *(f"    {prop}" for prop in props), "  }"]
            else:
                result = [
                    f"  return Object.assign(new {info['entity']}(), {{",
                    *(f"    {prop}" for prop in props),
                    "  })",
                ]
            signature = (
                f"export async function {names['write']}(model: {names['model']}, uow: UnitOfWork):"
                f" Promise<{names['target']}> {{"
                if body["uow"]
                else f"export function {names['write']}(model: {names['model']}): {names['target']} {{"
            )
            functions.append(
                lines(
                    f"/** {_article(plan['model'])} as the {info['name']} table takes it. */",
                    signature,
                    *(f"  {line}" for line in body["lines"]),
                    *result,
                    "}",
                )
            )
        if plan["read"] is not None:
            body = {"lines": [], "uow": False, "pairs": False}
            props = []
            for item in plan["read"]:
                field = (
                    next((candidate for candidate in model["fields"] if candidate["name"] == item["field"]), None)
                    if model
                    else None
                )
                prop = field_prop(item["field"])
                if item["value"]["kind"] == "todo":
                    props.extend([_todo_comment(item["value"], prop), f"{prop}: undefined as never,"])
                    continue
                expression = _read_expression(context, info, field, item["value"], body, imports)
                props.append(
                    f"{prop}: undefined as never, // TODO: no repository query reads it"
                    if expression is None
                    else f"{prop}: {expression},"
                )
            pairs = pairs or body["pairs"]
            if body["uow"]:
                imports.type("src/unit-of-work", "UnitOfWork")
            imports.type(module_of(context, info, "dtos" if dtos else "entity"), names["source"])
            article = _article(plan["model"]).split(" ")[0].lower()
            signature = (
                f"export async function {names['read']}(row: {names['source']}, uow: UnitOfWork):"
                f" Promise<{names['model']}> {{"
                if body["uow"]
                else f"export function {names['read']}(row: {names['source']}): {names['model']} {{"
            )
            functions.append(
                lines(
                    f"/** A row of the {info['name']} table as {article} {plan['model']}. */",
                    signature,
                    *(f"  {line}" for line in body["lines"]),
                    "  return {",
                    *(f"    {prop}" for prop in props),
                    "  }",
                    "}",
                )
            )
    helper = (
        [
            "",
            "/** The value an enum pair gives, or the fallback; a value without a pair is an error. */",
            "function pair(pairs: Record<string, string>, value: unknown, fallback?: string): string {",
            "  const found = pairs[String(value)] ?? fallback",
            "  if (found === undefined) throw new Error(`No pair for ${String(value)}`)",
            "  return found",
            "}",
        ]
        if pairs
        else []
    )
    content = lines(
        f'/** Conversions between the application models and the "{info["name"]}" table: what the service takes and'
        " returns. */",
        imports.write(),
        *helper,
        *[line for block in functions for line in ("", block)],
        "",
    )
    return {"path": path_of(module), "content": content}


def _has_todo(items: list[dict] | None) -> bool:
    return any(item["value"]["kind"] == "todo" for item in items or [])


def conversion_test_file(context: dict, plans: list[dict], can_make) -> dict | None:
    """The tests of the conversions: a row stored by the factories is read as the model, and a model that goes both
    ways and leaves nothing to the user is written back, giving every value of the row (lookups and Mapper's
    lossless transformations included)."""
    module = "test/conversions.test"
    imports = TsImports(module).from_("vitest", "describe", "expect", "it")
    memory = context["settings"]["memoryRepositories"]
    tests: list[str] = []
    for plan in plans:
        info = find_info(context, plan["table"])
        if not info or plan["read"] is None or _has_todo(plan["read"]) or not can_make(info):
            continue
        names = conversion_names(context, plan)
        reads = any(item["value"]["kind"] in ("lookup", "children") for item in plan["read"])
        writes = plan["write"] is not None and not _has_todo(plan["write"])
        write_uow = writes and any(item["value"]["kind"] == "lookup" for item in plan["write"])
        imports.from_(conversions_module(context, info), names["read"], *([names["write"]] if writes else []))
        imports.from_("test/factories", f"add{info['entity']}")
        body = [
            "const uow = new MemoryUnitOfWork()" if memory else "const uow = sqlUow()",
            f"const row = await add{info['entity']}(uow)",
            f"const model = {'await ' if reads else ''}{names['read']}(row{', uow' if reads else ''})",
        ]
        if writes:
            body.append(
                f"const values = {'await ' if write_uow else ''}{names['write']}(model{', uow' if write_uow else ''})"
            )
            for item in plan["write"]:
                prop = column_of(info, item["column"])["prop"]
                body.append(f"expect(values.{prop}).toEqual(row.{prop})")
        else:
            body.append("expect(model).toBeDefined()")
        named = _article(plan["model"])
        named = "a" + named[1:] if named.startswith("A") else named
        title = f"reads a row as {named} and writes it back" if writes else f"reads a row as {named}"
        tests.append(lines(f"  it('{title}', async () => {{", *(f"    {line}" for line in body), "  })"))
    if not tests:
        return None
    if memory:
        imports.from_("src/unit-of-work", "MemoryUnitOfWork")
    else:
        imports.from_("test/database", "useTestDatabase")
    content = lines(
        "/** Tests of the conversions between the application models and the tables. */",
        imports.write(),
        not memory
        and [
            "",
            "/** The repositories over the test database, opened empty for every test */",
            "const sqlUow = useTestDatabase()",
        ],
        "",
        "describe('conversions', () => {",
        *[line for index, test in enumerate(tests) for line in ([test] if index == 0 else ["", test])],
        "})",
        "",
    )
    return {"path": f"{module}.ts", "content": content}


def conversion_files(context: dict, schema: dict, plans: list[dict]) -> list[dict]:
    """The conversion files of a project and, when they are copied, the module of the models."""
    files = []
    for table in _unique([plan["table"] for plan in plans]):
        file = conversion_file(context, [plan for plan in plans if plan["table"] == table], schema)
        if file is not None:
            files.append(file)
    if not files:
        return files
    copied = context["settings"]["modelsSource"] == "copy"
    files.append(models_file(schema, plans, None if copied else models_import(context)))
    return files
