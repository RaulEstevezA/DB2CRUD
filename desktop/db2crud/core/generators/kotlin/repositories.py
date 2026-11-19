"""The repositories of each table: the interface services depend on (when the settings want one), its Exposed
implementation (DSL queries on the table object, each in a transaction that joins the one already open, rows turned into
entities, writes stored at once so a database refusal becomes a ConflictException, what the database fills read back
after an insert), and its in-memory one, with the same methods. Repositories decide nothing. Mirrors
web/src/core/generators/kotlin/repositories.ts."""

from .context import (
    column_of,
    common_package,
    errors_package,
    is_in,
    kt_file,
    memory_repository_class,
    package_of,
    path_of,
    qualified,
    query_name,
    repository_interface,
    sql_repository_class,
)
from .entities import kt_literal
from .kotlin import KtImports, kt_string
from .support import EXPOSED_TRANSACTION

CORE = "org.jetbrains.exposed.v1.core"
JDBC = "org.jetbrains.exposed.v1.jdbc"


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


# Exposed


def _t(info: dict, column: dict) -> str:
    return f"{info['tableObject']}.{column['prop']}"


def _soft_condition(info: dict, imports: KtImports) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    if not info["soft"]:
        return None
    imports.add(f"{CORE}.isNull")
    column = _t(info, info["soft"])
    if info["soft"]["column"]["type"]["kind"] != "boolean":
        return f"{column}.isNull()"
    imports.add(f"{CORE}.eq", f"{CORE}.or")
    return f"(({column} eq false) or {column}.isNull())"


def _all(conditions: list[str], imports: KtImports) -> str:
    """Conditions joined with and, each between parentheses when there are several."""
    if len(conditions) > 1:
        imports.add(f"{CORE}.and")
    return conditions[0] if len(conditions) == 1 else " and ".join(f"({condition})" for condition in conditions)


def _insert_columns(info: dict) -> list[dict]:
    """The columns written by an insert: not those the database fills (uuids are made first)."""
    return [column for column in info["columns"] if column["column"].get("generated") in (None, "uuid")]


def _update_columns(info: dict) -> list[dict]:
    """The columns written by an update: not the key, nor those the database fills."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None and not is_in(column, info["key"])
    ]


def _key_condition(info: dict, imports: KtImports) -> str:
    """The row of an entity, by its key."""
    imports.add(f"{CORE}.eq")
    return _all(
        [
            f"{_t(info, column)} eq entity.{column['prop']}{'' if column['column']['nullable'] else '!!'}"
            for column in info["key"]
        ],
        imports,
    )


def _order_by(info: dict, imports: KtImports) -> str:
    imports.add(f"{CORE}.SortOrder")
    return f".orderBy({', '.join(f'{_t(info, column)} to SortOrder.ASC' for column in info['key'])})"


def _select(info: dict, condition: str | None) -> str:
    """The query of a list, read with or without conditions."""
    return f"{info['tableObject']}.selectAll(){f'.where {{ {condition} }}' if condition else ''}"


def _exposed_body(context: dict, info: dict, method: dict, imports: KtImports) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info, imports)
    paging = context["settings"]["paging"]

    def by_columns() -> list[str]:
        imports.add(f"{CORE}.eq")
        return [f"{_t(info, column)} eq {column['prop']}" for column in columns]

    def read(lines: list[str]) -> list[str]:
        return ["return exposedTransaction(db) {", *(f"    {line}" for line in lines), "}"]

    imports.add(f"{JDBC}.selectAll")
    kind = method["query"]["kind"]
    if kind in ("getByKey", "findByUnique"):
        condition = _all([*by_columns(), *([soft] if soft else [])], imports)
        return read([f"{_select(info, condition)}.map {{ toEntity(it) }}.singleOrNull()"])
    if kind in ("listByParent", "findAllBy"):
        condition = _all([*by_columns(), *([soft] if soft else [])], imports)
        return read([f"{_select(info, condition)}{_order_by(info, imports)}.map {{ toEntity(it) }}"])
    if kind == "list":
        if paging == "offset":
            return read(
                [
                    f"val query = {_select(info, soft)}",
                    "val total = query.count()",
                    f"val items = query{_order_by(info, imports)}.limit(limit).offset(offset.toLong()).map {{ toEntity(it) }}",
                    "Page(items, total, offset, limit)",
                ]
            )
        if paging == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            key = info["key"]
            imports.add(f"{CORE}.greater")
            if len(key) > 1:
                imports.add(f"{CORE}.eq", f"{CORE}.or")
            for column in key:
                if column["ktImport"]:
                    imports.add(column["ktImport"])

            def value(column: dict, index: int) -> str:
                return f"(after[{index}] as {column['kt']})"

            items = []
            for index, column in enumerate(key):
                item = _all(
                    [
                        *(
                            f"{_t(info, before)} eq {value(before, position)}"
                            for position, before in enumerate(key[:index])
                        ),
                        f"{_t(info, column)} greater {value(column, index)}",
                    ],
                    imports,
                )
                items.append(f"({item})" if len(key) > 1 else item)
            after = " or ".join(items)
            with_after = _all([soft, after], imports) if soft else after
            next_key = ", ".join(f"items.last().{column['prop']}!!" for column in key)
            return read(
                [
                    f"val query = if (after == null) {_select(info, soft)} else {_select(info, with_after)}",
                    f"val rows = query{_order_by(info, imports)}.limit(limit + 1).map {{ toEntity(it) }}",
                    "val items = rows.take(limit)",
                    f"CursorPage(items, if (rows.size > limit) listOf<Any>({next_key}) else null)",
                ]
            )
        return read([f"{_select(info, soft)}{_order_by(info, imports)}.map {{ toEntity(it) }}"])
    if kind == "insert":
        imports.add(f"{JDBC}.insert")
        uuids = []
        for column in info["columns"]:
            if column["column"].get("generated") == "uuid":
                imports.add("java.util.UUID")
                uuids.append(f"    entity.{column['prop']} = entity.{column['prop']} ?: UUID.randomUUID()")
        primary_key = info["table"]["primaryKey"]
        identity = (
            next((column for column in info["key"] if column["column"].get("generated") == "identity"), None)
            if primary_key is not None and len(primary_key) == 1
            else None
        )
        return [
            "return write {",
            *uuids,
            f"    {'val statement = ' if identity else ''}{info['tableObject']}.insert {{ row ->",
            *(
                f"        entity.{column['prop']}?.let {{ row[{_t(info, column)}] = it }}"
                for column in _insert_columns(info)
            ),
            "    }",
            *([f"    entity.{identity['prop']} = statement[{_t(info, identity)}]"] if identity else []),
            # What the database filled is read back, by the key the row now has
            *([f"    fill(entity, {_select(info, _key_condition(info, imports))}.single())"] if primary_key else []),
            "    entity",
            "}",
        ]
    if kind == "update":
        imports.add(f"{JDBC}.update")
        return [
            "return write {",
            f"    {info['tableObject']}.update({{ {_key_condition(info, imports)} }}) {{ row ->",
            *(
                f"        row[{_t(info, column)}] = entity.{column['prop']}"
                if column["column"]["nullable"]
                else f"        entity.{column['prop']}?.let {{ row[{_t(info, column)}] = it }}"
                for column in _update_columns(info)
            ),
            "    }",
            "    entity",
            "}",
        ]
    if kind == "delete":
        imports.add(f"{JDBC}.deleteWhere")
        return ["write {", f"    {info['tableObject']}.deleteWhere {{ {_key_condition(info, imports)} }}", "}"]
    return ["throw UnsupportedOperationException()"]


def _exposed_helpers(context: dict, info: dict, imports: KtImports) -> list[str]:
    """toEntity, fill and write: how rows become entities, and how a refusal of the database becomes a ConflictException."""
    imports.add(f"{CORE}.ResultRow")
    writes = any(item["kind"] in ("insert", "update", "delete") for item in info["queries"])
    if writes:
        imports.add(
            "org.jetbrains.exposed.v1.exceptions.ExposedSQLException",
            qualified(errors_package(context), "ConflictException"),
        )
    entity = info["entity"]
    return [
        "",
        f"    private fun toEntity(row: ResultRow): {entity} = {entity}().also {{ fill(it, row) }}",
        "",
        f"    private fun fill(entity: {entity}, row: ResultRow) {{",
        *(f"        entity.{column['prop']} = row[{_t(info, column)}]" for column in info["columns"]),
        "    }",
        *(
            [
                "",
                "    /** Runs a write in a transaction; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */",
                "    private fun <T> write(work: () -> T): T =",
                "        try {",
                "            exposedTransaction(db) { work() }",
                "        } catch (error: ExposedSQLException) {",
                "            // SQLSTATE class 23: the change breaks a constraint (SQLite says so in its message)",
                '            if (!error.sqlState.startsWith("23") && error.cause?.message?.contains("SQLITE_CONSTRAINT") != true) throw error',
                f'            throw ConflictException({kt_string(entity)}, "the database refused the change: ${{error.cause?.message}}")',
                "        }",
            ]
            if writes
            else []
        ),
    ]


# In memory


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
    imports = KtImports(pkg).add(
        entity_class, qualified(package_of(context, info, "entity"), info["tableObject"]), EXPOSED_TRANSACTION
    )
    imports.add(f"{JDBC}.Database")
    methods = repository_methods(context, info, imports)
    modifier = "override " if interfaces else "open "
    bodies: list[str] = []
    for item in methods:
        bodies += _block(item, _exposed_body(context, info, item, imports), modifier, not interfaces)
    helpers = _exposed_helpers(context, info, imports)
    how = (
        "Every call joins the transaction of whoever holds the database, when there is one."
        if context["settings"]["transactions"] == "caller"
        else "Every call joins the transaction already open, or is committed at once."
    )
    files.append(
        kt_file(
            path_of(pkg, sql_repository_class(info)),
            pkg,
            imports.write(),
            [
                f"/** Keeps {info['name']} rows in the database, through Exposed. {how} */",
                f"class {sql_repository_class(info)}(private val db: Database) : {repository_interface(info)} {{"
                if interfaces
                else f"open class {sql_repository_class(info)}(private val db: Database?) {{",
                *bodies[1:],
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
