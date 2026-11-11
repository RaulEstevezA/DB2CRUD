"""The repository of each table: the interface services depend on (when the settings want one), its database
implementation (written by each ORM, common/orm.py) and its in-memory one, with the same methods. Repositories read
and write rows and never decide anything. Mirrors web/src/core/generators/typescript/common/repositories.ts."""

from ...types import indent, lines
from ..typescript import TsImports, ts_literal
from .context import (
    column_of,
    memory_repository_class,
    module_of,
    path_of,
    query_name,
    repository_interface,
    sql_repository_class,
)


def repository_methods(context: dict, info: dict, imports: TsImports) -> list[dict]:
    """The methods of a table's repository, with their TypeScript signatures."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods = []
    for query in info["queries"]:
        name = query_name(context, query)
        by_columns = [
            {"name": column_of(info, column)["prop"], "type": column_of(info, column)["ts"]}
            for column in query["columns"]
        ]
        kind = query["kind"]
        joined = " and ".join(query["columns"])

        def add(params, returns, doc, query=query, name=name):
            methods.append({"query": query, "name": name, "params": params, "returns": returns, "doc": doc})

        if kind == "getByKey":
            add(by_columns, f"{entity} | null", "The row with this primary key, or null.")
        elif kind == "findByUnique":
            add(by_columns, f"{entity} | null", f"The row with this {joined}, or null.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"{entity}[]", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                imports.type("src/paging", "Page")
                add(
                    [{"name": "offset", "type": "number"}, {"name": "limit", "type": "number"}],
                    f"Page<{entity}>",
                    "At most `limit` rows from `offset`, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                imports.type("src/paging", "CursorPage")
                add(
                    [{"name": "after", "type": "unknown[] | null"}, {"name": "limit", "type": "number"}],
                    f"CursorPage<{entity}>",
                    "At most `limit` rows after the key `after`, by primary key, and the key to read the next page from.",
                )
            else:
                add([], f"{entity}[]", "Every row, by primary key.")
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores the changes made to a row read from this repository.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "void", "Removes a row read from this repository.")
    return methods


# Default values of the list's parameters, in the classes (the interface leaves them optional)
DEFAULTS = {"offset": "0", "limit": "50", "after": "null"}


def _parameters(method: dict, with_defaults: bool) -> str:
    result = []
    for param in method["params"]:
        if method["query"]["kind"] == "list":
            if with_defaults:
                result.append(f"{param['name']}: {param['type']} = {DEFAULTS[param['name']]}")
            else:
                result.append(f"{param['name']}?: {param['type']}")
        else:
            result.append(f"{param['name']}: {param['type']}")
    return ", ".join(result)


def _method_block(method: dict, body: list) -> str:
    return lines(
        f"/** {method['doc']} */",
        f"async {method['name']}({_parameters(method, True)}): Promise<{method['returns']}> {{",
        indent(lines(*body), 2),
        "}",
    )


# In memory


def _memory_fill(context: dict, column: dict, imports: TsImports) -> str | None:
    """The value a new row gets for a column the database would fill."""
    db = column["column"]
    target = f"entity.{column['prop']}"
    unset = context["orm"]["unset"](target)
    generated = db.get("generated")
    if generated == "identity":
        return f"if ({unset}) {target} = this.nextId++"
    if generated == "uuid":
        imports.from_("node:crypto", "randomUUID")
        return f"if ({unset}) {target} = randomUUID()"
    if generated in ("now", "onUpdateNow"):
        return f"if ({unset}) {target} = new Date()"
    default = db.get("default")
    if default and default["kind"] == "literal":
        return f"if ({unset}) {target} = {ts_literal(default['value'])}"
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return "true"
    return f"!row.{soft['prop']}" if soft["column"]["type"]["kind"] == "boolean" else f"row.{soft['prop']} == null"


def _memory_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    rows = "this.visible()"
    conditions = " && ".join(f"row.{param['name']} === {param['name']}" for param in method["params"])
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return {rows}.find((row) => {conditions}) ?? null"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return {rows}.filter((row) => {conditions})"]
    if kind == "list":
        if paging == "offset":
            return [
                f"const rows = {rows}",
                "return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit }",
            ]
        if paging == "cursor":
            return [
                f"const rows = {rows}.filter((row) => after === null || compareKeys(keyOf(row), after) > 0)",
                "const items = rows.slice(0, limit)",
                "return { items, next: rows.length > limit ? keyOf(items[items.length - 1]) : null }",
            ]
        return [f"return {rows}"]
    if kind == "insert":
        fills = [
            line for line in (_memory_fill(context, column, imports) for column in info["columns"]) if line is not None
        ]
        return [*fills, "this.rows.set(JSON.stringify(keyOf(entity)), entity)", "return entity"]
    if kind == "update":
        return ["this.rows.set(JSON.stringify(keyOf(entity)), entity)", "return entity"]
    if kind == "delete":
        return ["this.rows.delete(JSON.stringify(keyOf(entity)))"]
    return ["throw new Error('not written')"]


def repository_file(context: dict, info: dict) -> dict:
    module = module_of(context, info, "repository")
    imports = TsImports(module).from_(module_of(context, info, "entity"), info["entity"])
    methods = repository_methods(context, info, imports)
    interfaces = context["settings"]["repositoryInterfaces"]
    memory = context["settings"]["memoryRepositories"]
    orm = context["orm"]
    # Written before the imports, which they add to
    sql_methods = [
        _method_block(method, orm["repository"]["body"](context, info, method, imports)) for method in methods
    ]
    init_lines = orm["repository"]["init"](context, imports)
    memory_methods = (
        [_method_block(method, _memory_body(context, info, method, imports)) for method in methods] if memory else []
    )
    identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
    implements = f" implements {repository_interface(info)}" if interfaces else ""
    entity = info["entity"]
    key_values = ", ".join("row." + column["prop"] for column in info["key"])
    content = lines(
        f'/** Repository of the "{info["name"]}" table: reads and writes rows, and decides nothing. */',
        imports.write(),
        "",
        interfaces
        and [
            f"/** Where {info['name']} rows are kept. Services depend only on this interface. */",
            f"export interface {repository_interface(info)} {{",
            *(f"  {method['name']}({_parameters(method, False)}): Promise<{method['returns']}>" for method in methods),
            "}",
            "",
        ],
        memory
        and [
            "/** The key of a row, as a list of its key values. */",
            f"function keyOf(row: {entity}): unknown[] {{",
            f"  return [{key_values}]",
            "}",
            "",
            "/** Orders two keys value by value. */",
            "function compareKeys(a: unknown[], b: unknown[]): number {",
            "  for (let index = 0; index < a.length; index++) {",
            "    const x = a[index] as number | string",
            "    const y = b[index] as number | string",
            "    if (x < y) return -1",
            "    if (x > y) return 1",
            "  }",
            "  return 0",
            "}",
            "",
        ],
        f"/** {orm['repository']['doc'](context, info)} */",
        f"export class {sql_repository_class(info)}{implements} {{",
        *((("" if line == "" else f"  {line}") if isinstance(line, str) else line) for line in init_lines),
        *[item for block in sql_methods for item in ("", indent(block, 2))],
        "}",
        memory
        and [
            "",
            f"/** Keeps {info['name']} rows in memory, for tests and for trying the services without a database. */",
            f"export class {memory_repository_class(info)}{implements} {{",
            f"  private readonly rows = new Map<string, {entity}>()",
            identity and "  private nextId = 1",
            "",
            f"  private visible(): {entity}[] {{",
            f"    return [...this.rows.values()].filter((row) => {_memory_visible(info)}).sort((a, b) => compareKeys(keyOf(a), keyOf(b)))",
            "  }",
            *[item for block in memory_methods for item in ("", indent(block, 2))],
            "}",
        ],
        "",
    )
    return {"path": path_of(module), "content": content}
