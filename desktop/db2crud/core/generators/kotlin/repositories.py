"""The repositories of each table: the interface services depend on (when the settings want one), its database
implementation (its bodies are the strategy's), and its in-memory one, with the same methods. Repositories decide nothing.
Mirrors web/src/core/generators/kotlin/repositories.ts."""

import re

from ...js import js_string
from .context import (
    column_of,
    common_package,
    kt_file,
    memory_repository_class,
    package_of,
    path_of,
    qualified,
    query_name,
    repository_interface,
    sql_repository_class,
)
from .kotlin import KtImports, kt_string


def repository_methods(context: dict, info: dict, imports: KtImports) -> list[dict]:
    """The methods of a table's repository, with their Kotlin signatures: {"query", "name", "params", "returns", "doc"}."""
    entity = info["entity"]
    paging = context["settings"]["paging"]
    methods: list[dict] = []
    for query_design in info["queries"]:
        name = query_name(context, query_design)
        by_columns = []
        for column in query_design["columns"]:
            info2 = column_of(info, column)
            if info2["ktImport"]:
                imports.add(info2["ktImport"])
            by_columns.append({"name": info2["prop"], "type": info2["kt"]})

        def add(params: list[dict], returns: str, doc: str, query_design=query_design, name=name) -> None:
            methods.append({"query": query_design, "name": name, "params": params, "returns": returns, "doc": doc})

        kind = query_design["kind"]
        joined = " and ".join(query_design["columns"])
        if kind == "getByKey":
            add(by_columns, f"{entity}?", "The row with this primary key, or null.")
        elif kind == "findByUnique":
            add(by_columns, f"{entity}?", f"The row with this {joined}, or null.")
        elif kind in ("listByParent", "findAllBy"):
            add(by_columns, f"List<{entity}>", f"Rows with this {joined}, by primary key.")
        elif kind == "list":
            if paging == "offset":
                imports.add(qualified(common_package(context), "Page"))
                add(
                    [{"name": "offset", "type": "Int"}, {"name": "limit", "type": "Int"}],
                    f"Page<{entity}>",
                    "At most limit rows from offset, by primary key, and how many there are.",
                )
            elif paging == "cursor":
                imports.add(qualified(common_package(context), "CursorPage"))
                add(
                    [{"name": "after", "type": "List<Any>?"}, {"name": "limit", "type": "Int"}],
                    f"CursorPage<{entity}>",
                    "At most limit rows after the key after (null for the first page), by primary key, and the key to read the next page from.",
                )
            else:
                add([], f"List<{entity}>", "Every row, by primary key.")
        elif kind == "insert":
            add(
                [{"name": "entity", "type": entity}],
                entity,
                "Stores a new row; the values the database fills are read back.",
            )
        elif kind == "update":
            add([{"name": "entity", "type": entity}], entity, "Stores the changes made to a row.")
        elif kind == "delete":
            add([{"name": "entity", "type": entity}], "Unit", "Removes a row.")
    return methods


def _signature(method: dict) -> str:
    params = ", ".join(f"{param['name']}: {param['type']}" for param in method["params"])
    return f"fun {method['name']}({params}): {method['returns']}"


# In memory


def kt_literal(column: dict, value) -> str:
    """A literal of a default, in the column's Kotlin type."""
    if isinstance(value, bool):
        return "true" if value else "false"
    text = js_string(value)
    kt = column["kt"]
    if kt == "Long":
        return f"{text}L"
    if kt == "Int":
        return text
    if kt == "Short":
        return f"{text}.toShort()"
    if kt == "BigDecimal":
        return f"BigDecimal({kt_string(text)})"
    if kt == "Double":
        return text if re.search(r"[.eE]", text) else f"{text}.0"
    if kt == "Float":
        return f"{text}f"
    if kt == "Boolean":
        return text
    if kt in ("LocalDate", "LocalTime", "LocalDateTime", "OffsetDateTime", "Instant"):
        return f"{kt}.parse({kt_string(text)})"
    if kt == "UUID":
        return f"UUID.fromString({kt_string(text)})"
    return kt_string(text)


def _memory_fill(column: dict, imports: KtImports) -> str | None:
    db = column["column"]
    target = f"entity.{column['prop']}"
    generated = db.get("generated")
    default = db.get("default")
    if generated == "identity":
        kt = column["kt"]
        following = "nextId++" if kt == "Long" else "(nextId++).toShort()" if kt == "Short" else "(nextId++).toInt()"
        return f"{target} = {target} ?: {following}"
    if generated == "uuid":
        imports.add("java.util.UUID")
        return f"{target} = {target} ?: UUID.randomUUID()"
    if generated in ("now", "onUpdateNow"):
        if column["ktImport"]:
            imports.add(column["ktImport"])
        if column["kt"] in ("LocalDate", "LocalTime", "LocalDateTime", "OffsetDateTime", "Instant"):
            return f"{target} = {target} ?: {column['kt']}.now()"
        return None
    if default is not None and default["kind"] == "literal" and default.get("value") is not None:
        if column["ktImport"]:
            imports.add(column["ktImport"])
        return f"{target} = {target} ?: {kt_literal(column, default['value'])}"
    return None


def _memory_visible(info: dict) -> str:
    soft = info["soft"]
    if not soft:
        return "true"
    return f"it.{soft['prop']} != true" if soft["column"]["type"]["kind"] == "boolean" else f"it.{soft['prop']} == null"


def _memory_body(context: dict, info: dict, method: dict) -> list[str]:
    conditions = " && ".join(
        f"it.{column_of(info, name)['prop']} == {column_of(info, name)['prop']}" for name in method["query"]["columns"]
    )
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [f"return visible().firstOrNull {{ {conditions} }}"]
    if kind in ("listByParent", "findAllBy"):
        return [f"return visible().filter {{ {conditions} }}"]
    if kind == "list":
        if paging == "offset":
            return [
                "val rows = visible()",
                "return Page(rows.drop(offset).take(limit), rows.size.toLong(), offset, limit)",
            ]
        if paging == "cursor":
            return [
                "val rows = visible().filter { after == null || compareKeys(keyOf(it), after) > 0 }",
                "val items = rows.take(limit)",
                "return CursorPage(items, if (rows.size > limit) keyOf(items.last()).map { it!! } else null)",
            ]
        return ["return visible()"]
    if kind in ("insert", "update"):
        return ["rows[keyOf(entity)] = entity", "return entity"]
    if kind == "delete":
        return ["rows.remove(keyOf(entity))"]
    return ["throw UnsupportedOperationException()"]


def _block(method: dict, body: list[str], modifier: str, doc: bool) -> list[str]:
    return [
        "",
        *([f"    /** {method['doc']} */"] if doc else []),
        f"    {modifier}{_signature(method)} {{",
        *(f"        {line}" for line in body),
        "    }",
    ]


def repository_files(context: dict, info: dict) -> list[dict]:
    pkg = package_of(context, info, "repository")
    entity_class = qualified(package_of(context, info, "entity"), info["entity"])
    interfaces = context["settings"]["repositoryInterfaces"]
    files: list[dict] = []
    if interfaces:
        imports = KtImports(pkg).add(entity_class)
        methods = repository_methods(context, info, imports)
        lines: list[str] = []
        for index, item in enumerate(methods):
            if index > 0:
                lines.append("")
            lines += [f"    /** {item['doc']} */", f"    {_signature(item)}"]
        files.append(
            kt_file(
                path_of(pkg, repository_interface(info)),
                pkg,
                imports.write(),
                [
                    f"/** Where {info['name']} rows are kept. Services depend only on this interface. */",
                    f"interface {repository_interface(info)} {{",
                    *lines,
                    "}",
                ],
            )
        )
    holder, repository = context["orm"]["holder"], context["orm"]["repository"]
    imports = KtImports(pkg).add(entity_class, holder["ktImport"], *repository["imports"](context, info))
    methods = repository_methods(context, info, imports)
    modifier = "override " if interfaces else "open "
    head = repository["head"](context, info)
    bodies: list[str] = []
    for item in methods:
        bodies += _block(item, repository["body"](context, info, item, imports), modifier, not interfaces)
    helpers = repository["helpers"](context, info, imports)
    kept = repository["kept"](context)
    files.append(
        kt_file(
            path_of(pkg, sql_repository_class(info)),
            pkg,
            imports.write(),
            [
                f"/** Keeps {info['name']} rows in the database, {repository['doc'](context)} */",
                f"class {sql_repository_class(info)}(private val {kept}: {holder['type']}) : {repository_interface(info)} {{"
                if interfaces
                else f"open class {sql_repository_class(info)}(private val {kept}: {holder['type']}?) {{",
                *head,
                *(bodies if head else bodies[1:]),
                *helpers,
                "}",
            ],
        )
    )
    if context["settings"]["memoryRepositories"]:
        imports = KtImports(pkg).add(entity_class)
        methods = repository_methods(context, info, imports)
        fills = [line for line in (_memory_fill(column, imports) for column in info["columns"]) if line is not None]
        bodies = []
        for item in methods:
            body = _memory_body(context, info, item)
            bodies += _block(item, [*fills, *body] if item["query"]["kind"] == "insert" else body, "override ", False)
        identity = any(column["column"].get("generated") == "identity" for column in info["columns"])
        entity = info["entity"]
        key_values = ", ".join(f"row.{column['prop']}" for column in info["key"])
        files.append(
            kt_file(
                path_of(pkg, memory_repository_class(info)),
                pkg,
                imports.write(),
                [
                    f"/** Keeps {info['name']} rows in memory, for tests and for trying the services without a database. */",
                    f"class {memory_repository_class(info)} : {repository_interface(info)} {{"
                    if interfaces
                    else f"class {memory_repository_class(info)} : {sql_repository_class(info)}(null) {{",
                    f"    private val rows = linkedMapOf<List<Any?>, {entity}>()",
                    "    private var nextId = 1L" if identity else None,
                    "",
                    "    /** The key of a row, as a list of its key values. */",
                    f"    private fun keyOf(row: {entity}): List<Any?> = listOf({key_values})",
                    "",
                    "    /** Orders two keys value by value. */",
                    '    @Suppress("UNCHECKED_CAST")',
                    "    private fun compareKeys(a: List<Any?>, b: List<Any?>): Int {",
                    "        for (index in a.indices) {",
                    "            val order = compareValues(a[index] as Comparable<Any>?, b[index] as Comparable<Any>?)",
                    "            if (order != 0) return order",
                    "        }",
                    "        return 0",
                    "    }",
                    "",
                    f"    private fun visible(): List<{entity}> =",
                    f"        rows.values.filter {{ {_memory_visible(info)} }}.sortedWith {{ a, b -> compareKeys(keyOf(a), keyOf(b)) }}",
                    *bodies,
                    "}",
                ],
            )
        )
    return files
