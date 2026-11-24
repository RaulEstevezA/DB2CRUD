"""* The repositories without an ORM: each one writes its SQL and runs it through Sql over a JDBC Connection. Rows are read into
the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or after a key; new rows
are read back (with RETURNING on PostgreSQL, by their key elsewhere); and a database refusal becomes a ConflictException.
 Mirrors
web/src/core/generators/kotlin/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..context import column_of, errors_package, is_in, qualified
from ..kotlin import KtImports, kt_string
from .database import read_column


def _q(context: dict, name: str):
    return quote_name(context["settings"]["database"], name)


def _table(context: dict, info: dict):
    return table_name(context["settings"]["database"], info["table"])


def _writable(column: dict):
    """A computed column is never written; the key of a stored row, and what the database fills on change, neither."""
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict):
    return (
        _writable(column)
        and not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _returns(context: dict):
    return context["settings"]["database"] == "postgresql"


def _soft_condition(context: dict, info: dict) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    if not info["soft"]:
        return None
    column = _q(context, info["soft"]["column"]["name"])
    return f"{column} = FALSE" if info["soft"]["column"]["type"]["kind"] == "boolean" else f"{column} IS NULL"


def _where_sql(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f" WHERE {' AND '.join(present)}" if len(present) > 0 else ""


def _equals(context: dict, columns: list[dict]):
    return [f"{_q(context, column['column']['name'])} = ?" for column in columns]


def _order_by(context: dict, info: dict):
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _args(values: list[str]):
    """The arguments after the SQL: the values of the statement."""
    return "".join(f", {value}" for value in values)


def _key_values(info: dict):
    return [f"entity.{column['prop']}" for column in info["key"]]


def sql_head(context: dict, info: dict) -> list[str]:
    """The columns every read selects, and the connection of a class that may have none."""
    held = (
        []
        if context["settings"]["repositoryInterfaces"]
        else ['    private val connection get() = checkNotNull(held) { "This repository has no connection" }', ""]
    )
    # A constant of the file would clash between repositories of the same package
    columns = ", ".join(_q(context, column["column"]["name"]) for column in info["columns"])
    return [*held, "    /** The columns every read selects. */", f"    private val columns = {kt_string(columns)}"]


def sql_helpers(context: dict, info: dict, imports: KtImports) -> list[str]:
    """How a row read with the columns becomes an entity, and how writes report a refusal."""
    imports.add("java.sql.ResultSet")
    writes = any(
        item["kind"] == "insert" or item["kind"] == "update" or item["kind"] == "delete" for item in info["queries"]
    )
    if writes:
        imports.add(f"{context['base']}.RefusedException", qualified(errors_package(context), "ConflictException"))
    return [
        "",
        f"    private fun toEntity(row: ResultSet): {info['entity']} = fill(row, {info['entity']}())",
        "",
        "    /** Reads a row selected with the columns into entity. */",
        f"    private fun fill(row: ResultSet, entity: {info['entity']}): {info['entity']} {{",
        *(
            f"        entity.{column['prop']} = {read_column(context, column, index + 1, imports)}"
            for index, column in enumerate(info["columns"])
        ),
        "        return entity",
        "    }",
        *(
            [
                "",
                "    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */",
                "    private fun <T> write(work: () -> T): T =",
                "        try {",
                "            work()",
                "        } catch (error: RefusedException) {",
                f'            throw ConflictException({kt_string(info["entity"])}, "the database refused the change: ${{error.message}}")',
                "        }",
            ]
            if writes
            else []
        ),
    ]


def _read_back(context: dict, info: dict) -> list[str]:
    """Reads a stored row again by its key, without the soft-delete filter, into the entity."""
    sql = kt_string(f" FROM {_table(context, info)}{_where_sql(_equals(context, info['key']))}")
    return [
        f'return Sql.one(connection, "SELECT " + columns + {sql}{_args(_key_values(info))}) {{ fill(it, entity) }}',
        f'    ?: error("The {info["entity"]} just written is not there")',
    ]


def _from_id(kt: str) -> str:
    """id turned into the type of the key."""
    if kt == "Int":
        return "id?.toInt()"
    return "id?.toShort()" if kt == "Short" else "id"


def _insert_lines(context: dict, info: dict, imports: KtImports) -> list[str]:
    """The values of an insert, and its SQL: values left null take the database's default."""
    written = [column for column in info["columns"] if _writable(column)]
    uuids = [column for column in written if column["column"].get("generated") == "uuid"]
    if len(uuids) > 0:
        imports.add("java.util.UUID")
    into = f"INSERT INTO {_table(context, info)}"
    mysql = context["settings"]["database"] == "mysql" or context["settings"]["database"] == "mariadb"
    return [
        *(f"entity.{column['prop']} = entity.{column['prop']} ?: UUID.randomUUID()" for column in uuids),
        "val given = listOf<Pair<String, Any?>>(",
        *(f"    {kt_string(_q(context, column['column']['name']))} to entity.{column['prop']}," for column in written),
        ").filter { it.second != null }",
        "val values = given.map { it.second }.toTypedArray()",
        "val sql =",
        ("    if (given.isEmpty()) " + kt_string(f"{into}{(' () VALUES ()' if mysql else ' DEFAULT VALUES')}")),
        (
            "    else "
            + kt_string(f"{into} (")
            + ' + given.joinToString(", ") { it.first } + ") VALUES (" + given.joinToString(", ") { "?" } + ")"'
        ),
    ]


def sql_body(context: dict, info: dict, method: dict, imports: KtImports) -> list[str]:
    imports.add(f"{context['base']}.Sql")
    entity = info["entity"]
    from_ = f" FROM {_table(context, info)}"

    def select(rest: str):
        return '"SELECT " + columns + ' + kt_string(f"{from_}{rest}")

    columns = [column_of(info, name) for name in method["query"]["columns"]]
    by_values = _args([column["prop"] for column in columns])
    soft = _soft_condition(context, info)
    order = _order_by(context, info)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [
            f"return Sql.one(connection, {select(_where_sql([*_equals(context, columns), soft]))}{by_values}) {{ toEntity(it) }}"
        ]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [
            (
                "return Sql.all(connection, "
                + select(f"{_where_sql([*_equals(context, columns), soft])}{order}")
                + f"{by_values}) {{ toEntity(it) }}"
            )
        ]
    if method["query"]["kind"] == "list":
        where = _where_sql([soft])
        if context["settings"]["paging"] == "offset":
            return [
                (
                    "val items = Sql.all(connection, "
                    + select(f"{where}{order} LIMIT ? OFFSET ?")
                    + ", limit, offset) { toEntity(it) }"
                ),
                (
                    "val total = Sql.one(connection, "
                    + kt_string(f"SELECT COUNT(*){from_}{where}")
                    + ") { it.getLong(1) } ?: 0L"
                ),
                "return Page(items, total, offset, limit)",
            ]
        if context["settings"]["paging"] == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            after = f"{key[0]} > ?" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join('?' for _ in key)})"
            next = [f"items.last().{column['prop']}!!" for column in info["key"]]
            return [
                "val rows =",
                (
                    "    if (after == null) Sql.all(connection, "
                    + select(f"{where}{order} LIMIT ?")
                    + ", limit + 1) { toEntity(it) }"
                ),
                (
                    "    else Sql.all(connection, "
                    + select(f"{_where_sql([soft, after])}{order} LIMIT ?")
                    + ", *after.toTypedArray(), limit + 1) { toEntity(it) }"
                ),
                "val items = rows.take(limit)",
                f"return CursorPage(items, if (rows.size > limit) listOf<Any>({', '.join(next)}) else null)",
            ]
        return [("return Sql.all(connection, " + select(f"{where}{order}") + ") { toEntity(it) }")]
    if method["query"]["kind"] == "insert":
        prepare = _insert_lines(context, info, imports)
        if _returns(context):
            return [
                *prepare,
                'return write { Sql.one(connection, sql + " RETURNING " + columns, *values) { fill(it, entity) } }',
                f'    ?: error("The {entity} just written is not there")',
            ]
        identity = (
            info["key"][0]
            if len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity"
            else None
        )
        return [
            *prepare,
            f"{('val id = ' if identity else '')}write {{ Sql.insert(connection, sql, *values) }}",
            *(
                [f"entity.{identity['prop']} = entity.{identity['prop']} ?: {_from_id(identity['kt'])}"]
                if identity
                else []
            ),
            *_read_back(context, info),
        ]
    if method["query"]["kind"] == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        mysql = context["settings"]["database"] == "mysql" or context["settings"]["database"] == "mariadb"
        now = "CURRENT_TIMESTAMP(6)" if mysql else "CURRENT_TIMESTAMP"
        sets = [*_equals(context, changes), *(f"{_q(context, column['column']['name'])} = {now}" for column in stamps)]
        if len(sets) == 0:
            return _read_back(context, info)
        sql = kt_string(
            f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where_sql(_equals(context, info['key']))}"
        )
        values = [*(f"entity.{column['prop']}" for column in changes), *_key_values(info)]
        return [f"write {{ Sql.run(connection, {sql}{_args(values)}) }}", *_read_back(context, info)]
    if method["query"]["kind"] == "delete":
        sql = kt_string(f"DELETE{from_}{_where_sql(_equals(context, info['key']))}")
        return [f"write {{ Sql.run(connection, {sql}{_args(_key_values(info))}) }}"]
    return ["throw UnsupportedOperationException()"]
