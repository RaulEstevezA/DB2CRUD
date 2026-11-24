"""The repositories of each table: the protocol services depend on (when the settings want one), its database implementation
(its bodies are the strategy's), and its in-memory one, with the same methods. Without protocols, the in-memory repository
is a subclass of the database one. Repositories decide nothing. Mirrors web/src/core/generators/swift/repositories.ts."""

import re

from ...js import js_string
from .context import (
    column_of,
    file_of,
    key_type,
    memory_repository,
    query_name,
    repository_protocol,
    sql_repository,
    sw_file,
)
from .swift import imports, sw_string


def repository_methods(context: dict, info: dict) -> list[dict]:
    """The methods of a table's repository, with their Swift signatures: {"query", "name", "params", "returns", "doc"}."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods: list[dict] = []
    for query_design in info["queries"]:
        name = query_name(context, query_design)
        by_columns = ", ".join(
            f"_ {column_of(info, column)['prop']}: {column_of(info, column)['sw']}"
            for column in query_design["columns"]
        )

        def add(params: str, returns: str, doc: str, query_design=query_design, name=name) -> None:
            methods.append({"query": query_design, "name": name, "params": params, "returns": returns, "doc": doc})

        kind = query_design["kind"]
        joined = " and ".join(query_design["columns"])
        if kind == "getByKey":
            add(by_columns, f"{entity}?", "The row with this primary key, or nil.")
        elif kind == "findByUnique":
            add(by_columns, f"{entity}?", f"The row with this {joined}, or nil.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"[{entity}]", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                add(
                    "offset: Int, limit: Int",
                    f"Page<{entity}>",
                    "At most limit rows from offset, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                add(
                    f"after: {key_type(info)}?, limit: Int",
                    f"CursorPage<{entity}, {key_type(info)}>",
                    "At most limit rows after the key after (nil for the first page), by primary key, and the key to read the next page from.",
                )
            else:
                add("", f"[{entity}]", "Every row, by primary key.")
        elif kind == "insert":
            add(f"_ entity: {entity}", entity, "Stores a new row; the values the database fills are read back.")
        elif kind == "update":
            add(f"_ entity: {entity}", entity, "Stores the changes made to a row.")
        elif kind == "delete":
            add(f"_ entity: {entity}", "", "Removes a row.")
    return methods


def _writes(method: dict) -> bool:
    return method["query"]["kind"] in ("insert", "update")


def _signature(method: dict, prefix: str = "") -> list[str]:
    """func findById(_ id: Int) async throws -> Customer?, with @discardableResult when it returns the row given."""
    returns = f" -> {method['returns']}" if method["returns"] else ""
    return [
        *(["@discardableResult"] if _writes(method) else []),
        f"{prefix}func {method['name']}({method['params']}) async throws{returns}",
    ]


def key_value(info: dict, variable: str) -> str:
    """The key of an entity known to be stored: $0.id!, or a tuple."""
    if len(info["key"]) == 1:
        return f"{variable}.{info['key'][0]['prop']}!"
    return f"({', '.join(column['key'] + ': ' + variable + '.' + column['prop'] + '!' for column in info['key'])})"


def _write_function(context: dict, info: dict, prefix: str) -> list[str]:
    """write: how a refusal of the database becomes a conflict."""
    return [
        "/// Runs a write; a database refusal (a unique value, a row still pointed to) becomes a conflict.",
        f"{prefix}func write<T>(_ work: () async throws -> T) async throws -> T {{",
        "    do {",
        "        return try await work()",
        f"    }} catch {context['orm']['repository']['refusal']} {{",
        f'        throw DomainError.conflict(entity: {sw_string(info["entity"])}, reason: "the database refused the change: \\(error)", fields: [])',
        "    }",
        "}",
    ]


# In memory


def _sw_literal(column: dict, value) -> str | None:
    """A literal of a default, as a Swift value of the column's type, when one can be written."""
    text = js_string(value)
    sw = column["sw"]
    if sw in ("Int", "Bool"):
        return text
    if sw in ("Double", "Float"):
        return text if re.search(r"[.eE]", text) else f"{text}.0"
    if sw == "String":
        return sw_string(text)
    if sw == "Decimal":
        return f"Decimal(string: {sw_string(text)})!"
    if sw == "UUID":
        return f"UUID(uuidString: {sw_string(text)})!"
    return None


def _memory_fill(column: dict) -> str | None:
    db = column["column"]
    target = f"entity.{column['prop']}"
    generated = db.get("generated")
    default = db.get("default")
    if generated == "identity":
        return f"if {target} == nil {{ {target} = await rows.nextId() }}"
    if generated == "uuid":
        return f"{target} = {target} ?? UUID()"
    if generated in ("now", "onUpdateNow"):
        return f"{target} = {target} ?? Date()" if column["sw"] == "Date" else None
    if default is not None and default["kind"] == "literal" and default.get("value") is not None:
        literal = _sw_literal(column, default["value"])
        return f"{target} = {target} ?? {literal}" if literal else None
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return ""
    if soft["column"]["type"]["kind"] == "boolean":
        return f".filter {{ $0.{soft['prop']} != true }}"
    return f".filter {{ $0.{soft['prop']} == nil }}"


def _memory_body(context: dict, info: dict, method: dict, fills: list[str]) -> list[str]:
    props = [column_of(info, name)["prop"] for name in method["query"]["columns"]]
    conditions = " && ".join(f"$0.{prop} == {prop}" for prop in props)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"await visible().first {{ {conditions} }}"]
    if kind in ("listByParent", "findAllBy"):
        return [f"await visible().filter {{ {conditions} }}"]
    if kind == "list":
        if paging == "offset":
            return [
                "let rows = await visible()",
                "return Page(items: Array(rows.dropFirst(offset).prefix(limit)), total: rows.count, offset: offset, limit: limit)",
            ]
        if paging == "cursor":
            return [
                "let rows = await visible().filter { row in after.map { isAfter(row, $0) } ?? true }",
                "let items = Array(rows.prefix(limit))",
                f"return CursorPage(items: items, next: rows.count > limit ? items.last.map {{ {key_value(info, '$0')} }} : nil)",
            ]
        return ["await visible()"]
    if kind == "insert":
        return [
            *(["var entity = entity", *fills] if fills else []),
            "let row = entity",
            "await rows.store(row) { sameKey($0, row) }",
            "return row",
        ]
    if kind == "update":
        return ["await rows.store(entity) { sameKey($0, entity) }", "return entity"]
    if kind == "delete":
        return ["await rows.remove { sameKey($0, entity) }"]
    return ['fatalError("not written")']


def _less_of(column: dict, a: str, b: str) -> str:
    """The order of two values of a column: < when they can be compared, by their text otherwise."""
    if column["comparable"]:
        return f"less({a}, {b})"
    return f'less({a}.map {{ "\\($0)" }}, {b}.map {{ "\\($0)" }})'


def _memory_helpers(info: dict, cursor: bool) -> list[str]:
    entity = info["entity"]
    key = info["key"]
    order = []
    for index, column in enumerate(key):
        prop = column["prop"]
        less = _less_of(column, f"a.{prop}", f"b.{prop}")
        order.append(
            f"    if a.{prop} != b.{prop} {{ return {less} }}" if index < len(key) - 1 else f"    return {less}"
        )

    def key_part(column: dict) -> str:
        return "key" if len(key) == 1 else f"key.{column['key']}"

    after = []
    for index, column in enumerate(key):
        prop = column["prop"]
        if column["comparable"]:
            less = f"less({key_part(column)}, row.{prop})"
        else:
            less = f'less("\\({key_part(column)})", row.{prop}.map {{ "\\($0)" }})'
        after.append(
            f"    if row.{prop} != {key_part(column)} {{ return {less} }}"
            if index < len(key) - 1
            else f"    return {less}"
        )
    same = " && ".join(f"a.{column['prop']} == b.{column['prop']}" for column in key)
    return [
        "",
        "/// Whether two rows have the same key.",
        f"fileprivate func sameKey(_ a: {entity}, _ b: {entity}) -> Bool {{",
        f"    {same}",
        "}",
        "",
        "/// Whether a row comes before another, by primary key.",
        f"fileprivate func isBefore(_ a: {entity}, _ b: {entity}) -> Bool {{",
        *order,
        "}",
        *(
            [
                "",
                "/// Whether a row comes after a key.",
                f"fileprivate func isAfter(_ row: {entity}, _ key: {key_type(info)}) -> Bool {{",
                *after,
                "}",
            ]
            if cursor
            else []
        ),
    ]


def _block(method: dict, body: list[str], prefix: str, doc: bool) -> list[str]:
    signature = _signature(method, prefix)
    return [
        "",
        *([f"    /// {method['doc']}"] if doc else []),
        *(f"    {line}{' {' if index == len(signature) - 1 else ''}" for index, line in enumerate(signature)),
        *(f"        {line}" for line in body),
        "    }",
    ]


def repository_file(context: dict, info: dict) -> dict:
    interfaces = context["settings"]["repositoryInterfaces"]
    holder = context["orm"]["holder"]
    methods = repository_methods(context, info)
    entity = info["entity"]
    body: list[str] = []
    if interfaces:
        declarations: list[str] = []
        for index, item in enumerate(methods):
            if index > 0:
                declarations.append("")
            declarations += [f"    /// {item['doc']}", *(f"    {line}" for line in _signature(item))]
        body += [
            f"/// Where {info['name']} rows are kept. Services depend only on this protocol.",
            f"public protocol {repository_protocol(info)}: Sendable {{",
            *declarations,
            "}",
            "",
        ]
    sql_bodies: list[str] = []
    for item in methods:
        sql_bodies += _block(item, context["orm"]["repository"]["body"](context, info, item), "public ", not interfaces)
    writes_rows = any(method["query"]["kind"] in ("insert", "update", "delete") for method in methods)
    reads = any(method["query"]["kind"] not in ("delete", "update") for method in methods)
    body += [
        f"/// Keeps {info['name']} rows in the database, through {context['orm']['label']}: on the database of the unit of work, or on its transaction.",
        f"public struct {sql_repository(info)}: {repository_protocol(info)} {{"
        if interfaces
        else f"public class {sql_repository(info)}: @unchecked Sendable {{",
        f"    let database: {holder['type']}" if interfaces else f"    private let db: {holder['optional']}",
        "",
        f"    public init(db: {holder['type']}) {{" if interfaces else f"    public init(db: {holder['optional']}) {{",
        "        self.database = db" if interfaces else "        self.db = db",
        "    }",
        *(
            []
            if interfaces
            else [
                "",
                "    /// The database; the in-memory subclass never asks for it.",
                f"    private var database: {holder['type']} {{ db! }}",
            ]
        ),
        *sql_bodies,
        *(["", *(f"    {line}" for line in _write_function(context, info, "private "))] if writes_rows else []),
        "}",
        *(
            ["", *context["orm"]["repository"]["functions"](context, info)]
            if reads or any(m["query"]["kind"] == "insert" for m in methods)
            else []
        ),
    ]
    if context["settings"]["memoryRepositories"]:
        fills = [line for line in (_memory_fill(column) for column in info["columns"]) if line is not None]
        cursor = (
            any(method["query"]["kind"] == "list" for method in methods) and context["settings"]["paging"] == "cursor"
        )
        prefix = "public " if interfaces else "override public "
        memory_bodies: list[str] = []
        for item in methods:
            memory_bodies += _block(item, _memory_body(context, info, item, fills), prefix, False)
        body += [
            "",
            f"/// Keeps {info['name']} rows in memory, for tests and for trying the services without a database.",
            f"public final class {memory_repository(info)}: {repository_protocol(info)} {{"
            if interfaces
            else f"public final class {memory_repository(info)}: {sql_repository(info)}, @unchecked Sendable {{",
            f"    private let rows = MemoryRows<{entity}>()",
            "",
            "    public init() {}" if interfaces else "    public init() {\n        super.init(db: nil)\n    }",
            "",
            "    /// The rows reads see, by primary key.",
            f"    private func visible() async -> [{entity}] {{",
            f"        await rows.all{_memory_visible(info)}.sorted(by: isBefore)",
            "    }",
            *memory_bodies,
            "}",
            *_memory_helpers(info, cursor),
        ]
    return sw_file(
        file_of(context, info, "repository", f"{entity}Repository"),
        imports("Foundation", *context["orm"]["repository"]["modules"](context, info)),
        body,
    )
