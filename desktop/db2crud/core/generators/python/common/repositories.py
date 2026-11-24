"""The repository of each table: the interface services depend on (a Protocol, when the settings want one), its
database implementation (written by each ORM, common/orm.py) and its in-memory one, with the same methods. Mirrors
web/src/core/generators/python/sqlalchemy/repositories.ts."""

from ....schema.documents import is_object_id
from ...types import indent, lines
from ..python import Imports, py_literal
from .context import (
    column_py_type,
    def_,
    memory_repository_class,
    module_of,
    path_of,
    query_name,
    repository_class,
    sql_repository_class,
)
from .documents import identified_lists, item_params, list_of


def _columns_of(info: dict, names: list[str]) -> list[dict]:
    return [next(column for column in info["columns"] if column["column"]["name"] == name) for name in names]


def repository_methods(context: dict, info: dict, imports: Imports) -> list[dict]:
    """The methods of a table's repository, with their Python signatures."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods = []
    for query in info["queries"]:
        name = query_name(context, query)
        by_columns = [
            {"name": column["attr"], "type": column_py_type(column, imports, False)}
            for column in _columns_of(info, query["columns"])
        ]
        kind = query["kind"]
        joined = " and ".join(query["columns"])

        def add(params, returns, doc, query=query, name=name):
            methods.append({"query": query, "name": name, "params": params, "returns": returns, "doc": doc})

        if kind == "getByKey":
            add(by_columns, f"{entity} | None", "The row with this primary key, or None.")
        elif kind == "findByUnique":
            add(by_columns, f"{entity} | None", f"The row with this {joined}, or None.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"list[{entity}]", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                imports.from_("app.paging", "Page")
                add(
                    [{"name": "offset", "type": "int = 0"}, {"name": "limit", "type": "int = 50"}],
                    f"Page[{entity}]",
                    "At most `limit` rows from `offset`, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                imports.from_("app.paging", "CursorPage").from_("typing", "Any")
                add(
                    [{"name": "after", "type": "tuple[Any, ...] | None = None"}, {"name": "limit", "type": "int = 50"}],
                    f"CursorPage[{entity}]",
                    "At most `limit` rows after the key `after`, by primary key, and the key to read the next page from.",
                )
            else:
                add([], f"list[{entity}]", "Every row, by primary key.")
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
        elif kind in ("addItem", "removeItem"):
            items = list_of(info, query)
            adds = kind == "addItem"

            def type_of(column: dict) -> str:
                return column_py_type(column, imports, False)

            params = (
                [{"name": items["item"], "type": type_of(items["itemColumn"])}] if adds else item_params(items, type_of)
            )
            # Told apart by its position, it is only removed from a list of the size it was seen in
            size = [{"name": "size", "type": "int"}] if not adds and items["by"] == "position" else []
            column = query["columns"][0]
            seen = " that has this size" if size else ""
            add(
                [*({"name": key["attr"], "type": type_of(key)} for key in info["key"]), *params, *size],
                f"{entity} | None",
                f"Adds an item to {column}, and gives the row as it is then, or None when there is none."
                if adds
                else f"Removes an item from {column}{seen}, and gives the row as it is then, or None when there is none.",
            )
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "None", "Removes a row read from this repository.")
    return methods


def signature(context: dict, method: dict) -> str:
    params = ", ".join(["self", *[f"{param['name']}: {param['type']}" for param in method["params"]]])
    return f"{def_(context)} {method['name']}({params}) -> {method['returns']}:"


# In memory


def memory_fill(context: dict, column: dict, imports: Imports) -> str | None:
    """The value a new row gets for a column the database would fill."""
    db = column["column"]
    attr = f"entity.{column['attr']}"
    unset = context["orm"]["unset"](attr, imports)
    generated = db.get("generated")
    if isinstance(generated, dict):
        # Reading it before it has a value would ask the database
        return f"{attr} = None" if context["orm"].get("lazyComputed") else None
    if generated == "identity":
        return f"if {unset}:\n    {attr} = self._next_id\n    self._next_id += 1"
    if generated == "uuid" and is_object_id(db["type"]):
        imports.from_("bson", "ObjectId")
        return f"if {unset}:\n    {attr} = str(ObjectId())"
    if generated == "uuid":
        imports.from_("uuid", "uuid4")
        return f"if {unset}:\n    {attr} = uuid4()"
    if generated in ("now", "onUpdateNow"):
        imports.from_("datetime", "UTC", "datetime")
        return f"if {unset}:\n    {attr} = datetime.now(UTC)"
    default = db.get("default")
    if default and default["kind"] == "literal":
        return f"if {unset}:\n    {attr} = {py_literal(default['value'])}"
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return "True"
    return f"not row.{soft['attr']}" if soft["column"]["type"]["kind"] == "boolean" else f"row.{soft['attr']} is None"


def _memory_body(context: dict, info: dict, method: dict, imports: Imports) -> list:
    def key_of(target: str) -> str:
        return "(" + ", ".join(f"{target}.{column['attr']}" for column in info["key"]) + ",)"

    rows = f"[row for row in sorted(self._rows.values(), key=self._key) if {_memory_visible(info)}]"
    kind = method["query"]["kind"]
    conditions = " and ".join(f"row.{param['name']} == {param['name']}" for param in method["params"])
    if kind in ("getByKey", "findByUnique"):
        return [f"return next((row for row in {rows} if {conditions}), None)"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return [row for row in {rows} if {conditions}]"]
    if kind == "list":
        paging = context["settings"]["paging"]
        if paging == "offset":
            return [
                f"rows = {rows}",
                "return Page(items=rows[offset : offset + limit], total=len(rows), offset=offset, limit=limit)",
            ]
        if paging == "cursor":
            return [
                f"rows = [row for row in {rows} if after is None or self._key(row) > tuple(after)]",
                "more = len(rows) > limit",
                "rows = rows[:limit]",
                "return CursorPage(items=rows, next=self._key(rows[-1]) if more else None)",
            ]
        return [f"return {rows}"]
    if kind == "insert":
        fills = [line for line in (memory_fill(context, column, imports) for column in info["columns"]) if line]
        return [*fills, *identified(info, imports), f"self._rows[{key_of('entity')}] = entity", "return entity"]
    if kind == "update":
        return [*identified(info, imports), f"self._rows[{key_of('entity')}] = entity", "return entity"]
    if kind in ("addItem", "removeItem"):
        return _memory_item(info, method, imports)
    if kind == "delete":
        return [f"self._rows.pop({key_of('entity')}, None)"]
    return ["raise NotImplementedError"]


def identified(info: dict, imports: Imports) -> list[str]:
    """The identifiers of the documents in its lists."""
    found = identified_lists(info)
    if found:
        imports.from_("app.documents", "identify")
    return [f"identify(entity.{column['attr']})" for column in found]


def _memory_item(info: dict, method: dict, imports: Imports) -> list:
    items = list_of(info, method["query"])
    attr = f"row.{items['column']['attr']}"
    item, by = items["item"], items["by"]
    if method["query"]["kind"] == "addItem":
        change = [f"{attr} = [*({attr} or []), {item}]"]
        if by == "id":
            imports.from_("app.documents", "identify")
            change.insert(0, f"identify([{item}])")
    elif by == "position":
        change = [
            f"if len({attr} or []) != size:",
            "    return None",
            f"{attr} = [*{attr}[:position], *{attr}[position + 1 :]]",
        ]
    else:
        kept = f'item["_id"] != {item}_id' if by == "id" else f"item != {item}"
        change = [f"{attr} = [item for item in {attr} or [] if {kept}]"]
    touched = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
    if touched:
        imports.from_("datetime", "UTC", "datetime")
    key = ", ".join(column["attr"] for column in info["key"])
    version = info["version"]
    return [
        f"row = next((row for row in self._rows.values() if self._key(row) == ({key},) and {_memory_visible(info)}), None)",
        "if row is None:",
        "    return None",
        *change,
        bool(version) and f"row.{version['attr']} = (row.{version['attr']} or 0) + 1",
        *(f"row.{column['attr']} = datetime.now(UTC)" for column in touched),
        "return row",
    ]


def _method_block(context: dict, method: dict, body: list) -> str:
    return lines(signature(context, method), f'    """{method["doc"]}"""', indent(lines(*body)))


def repository_file(context: dict, info: dict) -> dict:
    settings = context["settings"]
    imports = Imports().annotations().from_(module_of(context, info, "entity"), info["entity"])
    methods = repository_methods(context, info, imports)
    if settings["repositoryInterfaces"]:
        imports.from_("typing", "Protocol")
    orm = context["orm"]
    sql_methods = [
        _method_block(context, method, orm["repository"]["body"](context, info, method, imports)) for method in methods
    ]
    memory_methods = (
        [_method_block(context, method, _memory_body(context, info, method, imports)) for method in methods]
        if settings["memoryRepositories"]
        else []
    )
    if settings["memoryRepositories"]:
        imports.from_("typing", "Any")
    identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
    # Written before the imports, which they may add to
    init_lines = orm["repository"]["init"](context, imports)
    helper_lines = orm["repository"].get("helpers", lambda _context, _info, _imports: [])(context, info, imports)
    key = ", ".join(f"row.{column['attr']}" for column in info["key"])
    content = lines(
        f'"""Repository of the "{info["name"]}" table: reads and writes rows, and decides nothing."""',
        "",
        imports.write("app"),
        settings["repositoryInterfaces"]
        and [
            "",
            "",
            f"class {repository_class(info)}(Protocol):",
            f'    """Where {info["name"]} rows are kept. Services depend only on this interface."""',
            *[
                item
                for method in methods
                for item in ["", indent(lines(signature(context, method), f'    """{method["doc"]}"""', "    ..."))]
            ],
        ],
        "",
        "",
        f"class {sql_repository_class(info)}:",
        f'    """{orm["repository"]["doc"](context, info)}"""',
        "",
        *[f"    {line}" if isinstance(line, str) else line for line in init_lines],
        *[item for block in sql_methods for item in ["", indent(block)]],
        *helper_lines,
        settings["memoryRepositories"]
        and [
            "",
            "",
            f"class {memory_repository_class(info)}:",
            f'    """Keeps {info["name"]} rows in memory, for tests and for trying the services without a database."""',
            "",
            "    def __init__(self) -> None:",
            f"        self._rows: dict[tuple[Any, ...], {info['entity']}] = {{}}",
            identity and "        self._next_id = 1",
            "",
            "    @staticmethod",
            f"    def _key(row: {info['entity']}) -> tuple[Any, ...]:",
            f"        return ({key},)",
            *[item for block in memory_methods for item in ["", indent(block)]],
        ],
        "",
    )
    return {"path": path_of(module_of(context, info, "repository")), "content": content}
