"""* The repositories without an ORM: each one writes its SQL and runs it through SQLKit on Db (the pool, or a transaction).
Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or
after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a
database refusal becomes a conflict. Mirrors
web/src/core/generators/swift/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..context import column_of, is_in
from ..repositories import key_value
from ..swift import sw_string
from .database import bind_optional, bind_value, code, read_column, selected, statement


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
    return context["settings"]["database"] == "postgresql" or context["settings"]["database"] == "sqlite"


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
    """ "id" = … with the values of some variables."""
    return [
        f"{_q(context, column['column']['name'])} = {bind_value(context, column, column['prop'])}" for column in columns
    ]


def _key_equals(context: dict, info: dict):
    """ "id" = … with the key of the entity."""
    return [
        (f"{_q(context, column['column']['name'])} = " + bind_value(context, column, f"entity.{column['prop']}!"))
        for column in info["key"]
    ]


def _order_by(context: dict, info: dict):
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _select(rest: str):
    """The statement that reads the rows of a FROM, run on the database."""
    return "database.sql.raw(" + statement(f"SELECT {code('unsafeRaw: columns')}{rest}") + ")"


def sql_functions(context: dict, info: dict) -> list[str]:
    """The functions after the type: the columns a read selects, and how a row becomes an entity."""
    columns = ", ".join(selected(context, column) for column in info["columns"])
    return [
        "/// The columns every read selects.",
        f"fileprivate let columns = {sw_string(columns)}",
        "",
        f"fileprivate func toEntity(_ row: any SQLRow) throws -> {info['entity']} {{",
        f"    {info['entity']}(",
        *(
            f"        {column['key']}: {read_column(context, column)}{('' if index == len(info['columns']) - 1 else ',')}"
            for index, column in enumerate(info["columns"])
        ),
        "    )",
        "}",
    ]


def _read_back(context: dict, info: dict):
    """Reads a stored row again by its key, without the soft-delete filter."""
    return [
        (
            "return try await "
            + _select(f" FROM {_table(context, info)}{_where_sql(_key_equals(context, info))}")
            + ".first().map(toEntity) ?? entity"
        )
    ]


def _given_line(context: dict, column: dict) -> str:
    """The line of an insert that gives a column its value, when it has one."""
    name = sw_string(_q(context, column["column"]["name"]))
    value = statement(bind_value(context, column, "value"))
    return f"if let value = entity.{column['prop']} {{ names.append({name}); values.append(SQLQueryString({value})) }}"


def _insert_lines(context: dict, info: dict) -> list[str]:
    """The statement of an insert: columns left nil take the database's default."""
    written = [column for column in info["columns"] if _writable(column)]
    uuids = [column for column in written if column["column"].get("generated") == "uuid" and column["sw"] == "UUID"]
    identity = (
        len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity" and not _returns(context)
    )
    into = f"INSERT INTO {_table(context, info)}"
    given = f"{into} (" + code('unsafeRaw: names.joined(separator: ", ")') + f") VALUES ({code('SQLList(values)')})"
    return [
        *(["var entity = entity"] if len(uuids) > 0 or identity else []),
        *(f"entity.{column['prop']} = entity.{column['prop']} ?? UUID()" for column in uuids),
        "var names: [String] = []",
        "var values: [any SQLExpression] = []",
        *(_given_line(context, column) for column in written),
        "let insert: SQLQueryString =",
        ("    names.isEmpty ? " + statement(f"{into}{(' DEFAULT VALUES' if _returns(context) else ' () VALUES ()')}")),
        f"    : {statement(given)}",
    ]


def sql_body(context: dict, info: dict, method: dict) -> list[str]:
    from_ = f" FROM {_table(context, info)}"
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    soft = _soft_condition(context, info)
    order = _order_by(context, info)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [
            (
                "try await "
                + _select(f"{from_}{_where_sql([*_equals(context, columns), soft])}")
                + ".first().map(toEntity)"
            )
        ]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [
            (
                "try await "
                + _select(f"{from_}{_where_sql([*_equals(context, columns), soft])}{order}")
                + ".all().map(toEntity)"
            )
        ]
    if method["query"]["kind"] == "list":
        where = _where_sql([soft])
        if context["settings"]["paging"] == "offset":
            page = f"{from_}{where}{order} LIMIT {code('bind: limit')} OFFSET {code('bind: offset')}"
            count = statement(f"SELECT COUNT(*) AS total{from_}{where}")
            return [
                f'let total = try await database.sql.raw({count}).first()?.decode(column: "total", as: Int.self) ?? 0',
                f"let items = try await {_select(page)}.all().map(toEntity)",
                "return Page(items: items, total: total, offset: offset, limit: limit)",
            ]
        if context["settings"]["paging"] == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            values = [
                bind_value(context, column, ("after" if len(info["key"]) == 1 else f"after.{column['key']}"))
                for column in info["key"]
            ]
            after = f"{key[0]} > {values[0]}" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join(values)})"
            limit = f" LIMIT {code('bind: limit + 1')}"
            return [
                "let rows =",
                "    if let after {",
                ("        try await " + _select(f"{from_}{_where_sql([soft, after])}{order}{limit}") + ".all()"),
                "    } else {",
                ("        try await " + _select(f"{from_}{where}{order}{limit}") + ".all()"),
                "    }",
                "let items = try rows.prefix(limit).map(toEntity)",
                f"return CursorPage(items: items, next: rows.count > limit ? items.last.map {{ {key_value(info, '$0')} }} : nil)",
            ]
        return [("try await " + _select(f"{from_}{where}{order}") + ".all().map(toEntity)")]
    if method["query"]["kind"] == "insert":
        prepare = _insert_lines(context, info)
        if _returns(context):
            returning = statement(f"{code('insert')} RETURNING {code('unsafeRaw: columns')}")
            return [
                *prepare,
                f"let row = try await write {{ try await database.sql.raw({returning}).first() }}",
                "return try row.map(toEntity) ?? entity",
            ]
        identity = (
            info["key"][0]
            if len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity"
            else None
        )
        return [
            *prepare,
            *(
                [
                    "let id = try await write { try await database.insert(insert) }",
                    f"entity.{identity['prop']} = entity.{identity['prop']} ?? id",
                ]
                if identity
                else ["try await write { try await database.sql.raw(insert).run() }"]
            ),
            *_read_back(context, info),
        ]
    if method["query"]["kind"] == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        now = "CURRENT_TIMESTAMP" if _returns(context) else "CURRENT_TIMESTAMP(6)"
        sets = [
            *(
                (
                    f"{_q(context, column['column']['name'])} = "
                    + bind_optional(context, column, f"entity.{column['prop']}")
                )
                for column in changes
            ),
            *(f"{_q(context, column['column']['name'])} = {now}" for column in stamps),
        ]
        if len(sets) == 0:
            return _read_back(context, info)
        sql = statement(f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where_sql(_key_equals(context, info))}")
        return [f"try await write {{ try await database.sql.raw({sql}).run() }}", *_read_back(context, info)]
    if method["query"]["kind"] == "delete":
        sql = statement(f"DELETE{from_}{_where_sql(_key_equals(context, info))}")
        return [f"try await write {{ try await database.sql.raw({sql}).run() }}"]
    return ['fatalError("not written")']
