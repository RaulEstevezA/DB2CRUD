"""* The Exposed repositories: DSL queries on the table object, each in a transaction that joins the one already open, rows
turned into entities, writes stored at once so a database refusal becomes a ConflictException, what the database fills
read back after an insert. Mirrors
web/src/core/generators/kotlin/exposed/repository.ts."""

from ..context import column_of, errors_package, is_in, qualified
from ..kotlin import KtImports, kt_string

_CORE = "org.jetbrains.exposed.v1.core"

_JDBC = "org.jetbrains.exposed.v1.jdbc"


def _t(info: dict, column: dict):
    return f"{info['tableObject']}.{column['prop']}"


def _soft_condition(info: dict, imports: KtImports) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    if not info["soft"]:
        return None
    imports.add(f"{_CORE}.isNull")
    column = _t(info, info["soft"])
    if info["soft"]["column"]["type"]["kind"] != "boolean":
        return f"{column}.isNull()"
    imports.add(f"{_CORE}.eq", f"{_CORE}.or")
    return f"(({column} eq false) or {column}.isNull())"


def _all(conditions: list[str], imports: KtImports) -> str:
    """Conditions joined with and, each between parentheses when there are several."""
    if len(conditions) > 1:
        imports.add(f"{_CORE}.and")
    return conditions[0] if len(conditions) == 1 else " and ".join(f"({condition})" for condition in conditions)


def _insert_columns(info: dict):
    """The columns written by an insert: not those the database fills (uuids are made first)."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None or column["column"].get("generated") == "uuid"
    ]


def _update_columns(info: dict):
    """The columns written by an update: not the key, nor those the database fills."""
    return [
        column
        for column in info["columns"]
        if column["column"].get("generated") is None and not is_in(column, info["key"])
    ]


def _key_condition(info: dict, imports: KtImports) -> str:
    """The row of an entity, by its key."""
    imports.add(f"{_CORE}.eq")
    return _all(
        [
            f"{_t(info, column)} eq entity.{column['prop']}{('' if column['column']['nullable'] else '!!')}"
            for column in info["key"]
        ],
        imports,
    )


def _order_by(info: dict, imports: KtImports) -> str:
    imports.add(f"{_CORE}.SortOrder")
    return ".orderBy(" + ", ".join(f"{_t(info, column)} to SortOrder.ASC" for column in info["key"]) + ")"


def _select(info: dict, condition: str | None):
    """The query of a list, read with or without conditions."""
    return f"{info['tableObject']}.selectAll()" + (f".where {{ {condition} }}" if condition else "")


def exposed_body(context: dict, info: dict, method: dict, imports: KtImports) -> list[str]:
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(info, imports)

    def by_columns():
        imports.add(f"{_CORE}.eq")
        return [f"{_t(info, column)} eq {column['prop']}" for column in columns]

    def read(lines: list[str]):
        return ["return exposedTransaction(db) {", *(f"    {line}" for line in lines), "}"]

    imports.add(f"{_JDBC}.selectAll")
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return read(
            [
                f"{_select(info, _all([*by_columns(), *([soft] if soft else [])], imports))}.map {{ toEntity(it) }}.singleOrNull()"
            ]
        )
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return read(
            [
                f"{_select(info, _all([*by_columns(), *([soft] if soft else [])], imports))}{_order_by(info, imports)}.map {{ toEntity(it) }}"
            ]
        )
    if method["query"]["kind"] == "list":
        if context["settings"]["paging"] == "offset":
            return read(
                [
                    f"val query = {_select(info, soft)}",
                    "val total = query.count()",
                    f"val items = query{_order_by(info, imports)}.limit(limit).offset(offset.toLong()).map {{ toEntity(it) }}",
                    "Page(items, total, offset, limit)",
                ]
            )
        if context["settings"]["paging"] == "cursor":
            # After the key (a, b): a greater, or a the same and b greater
            imports.add(f"{_CORE}.greater")
            if len(info["key"]) > 1:
                imports.add(f"{_CORE}.eq", f"{_CORE}.or")
            for column in info["key"]:
                if column["ktImport"]:
                    imports.add(column["ktImport"])

            def value(column: dict, index: int):
                return f"(after[{index}] as {column['kt']})"

            after = " or ".join(
                (f"({item})" if len(info["key"]) > 1 else item)
                for item in [
                    _all(
                        [
                            *(
                                f"{_t(info, before)} eq {value(before, position)}"
                                for position, before in enumerate(info["key"][:index])
                            ),
                            f"{_t(info, column)} greater {value(column, index)}",
                        ],
                        imports,
                    )
                    for index, column in enumerate(info["key"])
                ]
            )
            with_after = _all([soft, after], imports) if soft else after
            return read(
                [
                    f"val query = if (after == null) {_select(info, soft)} else {_select(info, with_after)}",
                    f"val rows = query{_order_by(info, imports)}.limit(limit + 1).map {{ toEntity(it) }}",
                    "val items = rows.take(limit)",
                    (
                        "CursorPage(items, if (rows.size > limit) listOf<Any>("
                        + ", ".join(f"items.last().{column['prop']}!!" for column in info["key"])
                        + ") else null)"
                    ),
                ]
            )
        return read([f"{_select(info, soft)}{_order_by(info, imports)}.map {{ toEntity(it) }}"])
    if method["query"]["kind"] == "insert":
        imports.add(f"{_JDBC}.insert")
        uuids = []
        for column in [column for column in info["columns"] if column["column"].get("generated") == "uuid"]:
            imports.add("java.util.UUID")
            uuids.append(f"    entity.{column['prop']} = entity.{column['prop']} ?: UUID.randomUUID()")
        identity = (
            next((column for column in info["key"] if column["column"].get("generated") == "identity"), None)
            if len(info["table"]["primaryKey"]) == 1
            else None
        )
        return [
            "return write {",
            *uuids,
            f"    {('val statement = ' if identity else '')}{info['tableObject']}.insert {{ row ->",
            *(
                f"        entity.{column['prop']}?.let {{ row[{_t(info, column)}] = it }}"
                for column in _insert_columns(info)
            ),
            "    }",
            *([f"    entity.{identity['prop']} = statement[{_t(info, identity)}]"] if identity else []),
            *(
                [f"    fill(entity, {_select(info, _key_condition(info, imports))}.single())"]
                if info["table"]["primaryKey"]
                else []
            ),
            "    entity",
            "}",
        ]
    if method["query"]["kind"] == "update":
        imports.add(f"{_JDBC}.update")
        return [
            "return write {",
            f"    {info['tableObject']}.update({{ {_key_condition(info, imports)} }}) {{ row ->",
            *(
                (
                    f"        row[{_t(info, column)}] = entity.{column['prop']}"
                    if column["column"]["nullable"]
                    else f"        entity.{column['prop']}?.let {{ row[{_t(info, column)}] = it }}"
                )
                for column in _update_columns(info)
            ),
            "    }",
            "    entity",
            "}",
        ]
    if method["query"]["kind"] == "delete":
        imports.add(f"{_JDBC}.deleteWhere")
        return ["write {", f"    {info['tableObject']}.deleteWhere {{ {_key_condition(info, imports)} }}", "}"]
    return ["throw UnsupportedOperationException()"]


def exposed_helpers(context: dict, info: dict, imports: KtImports) -> list[str]:
    """toEntity, fill and write: how rows become entities, and how a refusal of the database becomes a ConflictException."""
    imports.add(f"{_CORE}.ResultRow")
    writes = any(
        item["kind"] == "insert" or item["kind"] == "update" or item["kind"] == "delete" for item in info["queries"]
    )
    if writes:
        imports.add(
            "org.jetbrains.exposed.v1.exceptions.ExposedSQLException",
            qualified(errors_package(context), "ConflictException"),
        )
    return [
        "",
        f"    private fun toEntity(row: ResultRow): {info['entity']} = {info['entity']}().also {{ fill(it, row) }}",
        "",
        f"    private fun fill(entity: {info['entity']}, row: ResultRow) {{",
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
                f'            throw ConflictException({kt_string(info["entity"])}, "the database refused the change: ${{error.cause?.message}}")',
                "        }",
            ]
            if writes
            else []
        ),
    ]
