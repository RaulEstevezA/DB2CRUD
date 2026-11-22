"""The repositories without an ORM: each one writes its SQL and runs it through Sql over a JDBC Connection (the
application's, or one in a transaction). Rows are read into the plain entities column by column; reads leave out rows
marked as deleted; pages go by offset or after a key; new rows are read back (with RETURNING on PostgreSQL, by their key
elsewhere); and a database refusal becomes a ConflictException. Mirrors web/src/core/generators/java/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..context import column_of, errors_package, is_in, sql_repository_class
from ..java import JavaImports, java_string
from .database import read_call


def _q(context: dict, name: str) -> str:
    return quote_name(context["settings"]["database"], name)


def _table(context: dict, info: dict) -> str:
    return table_name(context["settings"]["database"], info["table"])


def _writable(column: dict) -> bool:
    """A computed column is never written."""
    return not isinstance(column["column"].get("generated"), dict)


def _changeable(info: dict, column: dict) -> bool:
    """Nor the key of a stored row, nor what the database fills on change."""
    return (
        _writable(column)
        and not is_in(column, info["key"])
        and not column["generated"]
        and column["column"].get("generated") != "onUpdateNow"
    )


def _returns(context: dict) -> bool:
    return context["settings"]["database"] == "postgresql"


def _select_list(context: dict, info: dict) -> str:
    """ "id", "name": the columns every read selects, in the order fill reads them."""
    return ", ".join(_q(context, column["column"]["name"]) for column in info["columns"])


def _soft_condition(context: dict, info: dict) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    soft = info["soft"]
    if not soft:
        return None
    column = _q(context, soft["column"]["name"])
    return f"{column} = FALSE" if soft["column"]["type"]["kind"] == "boolean" else f"{column} IS NULL"


def _where(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f" WHERE {' AND '.join(present)}" if present else ""


def _equals(context: dict, columns: list[dict]) -> list[str]:
    return [f"{_q(context, column['column']['name'])} = ?" for column in columns]


def _order_by(context: dict, info: dict) -> str:
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _args(values: list[str]) -> str:
    """The arguments after the SQL and the reader: the values."""
    return "".join(f", {value}" for value in values)


def _key_values(info: dict, target: str = "entity") -> list[str]:
    return [f"{target}.{column['getter']}()" for column in info["key"]]


def sql_head(context: dict, info: dict, imports: JavaImports) -> list:
    """The columns a read selects, the connection and the constructor."""
    imports.add("java.sql.Connection", f"{context['base']}.Sql")
    return [
        "    /** The columns every read selects. */",
        f"    private static final String COLUMNS = {java_string(_select_list(context, info))};",
        "",
        "    protected final Connection connection;",
        "",
        f"    public {sql_repository_class(info)}(Connection connection) {{",
        "        this.connection = connection;",
        "    }",
    ]


def sql_tail(context: dict, info: dict, imports: JavaImports) -> list:
    """How a row read with COLUMNS becomes an entity."""
    imports.add("java.sql.ResultSet", "java.sql.SQLException")
    entity = info["entity"]
    return [
        "",
        f"    /** The {entity} of a row read with COLUMNS. */",
        f"    private static {entity} toEntity(ResultSet row) throws SQLException {{",
        f"        return fill(row, new {entity}());",
        "    }",
        "",
        "    /** Reads a row selected with COLUMNS into entity. */",
        f"    private static {entity} fill(ResultSet row, {entity} entity) throws SQLException {{",
        *(
            f"        entity.{column['setter']}({read_call(context, column, index + 1)});"
            for index, column in enumerate(info["columns"])
        ),
        "        return entity;",
        "    }",
    ]


def _write(context: dict, info: dict, action: list, imports: JavaImports, after: list | None = None) -> list:
    """A write, with a refusal of the database turned into a ConflictException."""
    imports.add(f"{errors_package(context)}.ConflictException")
    return [
        "try {",
        *(f"    {line}" if isinstance(line, str) else line for line in action),
        "} catch (Sql.RefusedException error) {",
        f'    throw new ConflictException("{info["entity"]}", "the database refused the change: " + error.getMessage());',
        "}",
        *(after or []),
    ]


def _read_back(context: dict, info: dict) -> list:
    """Reads a stored row again by its key, without the soft-delete filter, into the entity."""
    sql = java_string(f" FROM {_table(context, info)}{_where(_equals(context, info['key']))}")
    return [
        f'return Sql.one(connection, "SELECT " + COLUMNS + {sql}, (row) -> fill(row, entity){_args(_key_values(info))})',
        f'        .orElseThrow(() -> new IllegalStateException("The {info["entity"]} just written is not there"));',
    ]


def _from_id(java: str) -> str:
    """(long) id turned into the type of the key."""
    if java == "Integer":
        return "id.intValue()"
    if java == "Short":
        return "id.shortValue()"
    return "id"


def sql_body(context: dict, info: dict, method: dict, imports: JavaImports) -> list:
    entity = info["entity"]
    reader = f"{sql_repository_class(info)}::toEntity"
    from_ = f" FROM {_table(context, info)}"

    def select(rest: str) -> str:
        return f'"SELECT " + COLUMNS + {java_string(from_ + rest)}'

    columns = [column_of(info, name) for name in method["query"]["columns"]]
    by_values = _args([column["prop"] for column in columns])
    soft = _soft_condition(context, info)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    order = _order_by(context, info)
    if kind in ("getByKey", "findByUnique"):
        return [
            f"return Sql.one(connection, {select(_where([*_equals(context, columns), soft]))}, {reader}{by_values});"
        ]
    if kind in ("listByParent", "findAllBy"):
        rest = _where([*_equals(context, columns), soft]) + order
        return [f"return Sql.all(connection, {select(rest)}, {reader}{by_values});"]
    if kind == "list":
        where = _where([soft])
        if paging == "offset":
            imports.add("java.util.List")
            return [
                f"List<{entity}> items = Sql.all(connection, {select(f'{where}{order} LIMIT ? OFFSET ?')}, {reader}, limit, offset);",
                f"long total = Sql.one(connection, {java_string(f'SELECT COUNT(*){from_}{where}')}, (row) -> row.getLong(1)).orElse(0L);",
                "return new Page<>(items, total, offset, limit);",
            ]
        if paging == "cursor":
            imports.add("java.util.ArrayList", "java.util.List")
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            after = f"{key[0]} > ?" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join('?' for _ in key)})"
            after_values = [f"after.get({index})" for index in range(len(info["key"]))]
            last = ", ".join(f"last.{column['getter']}()" for column in info["key"])
            return [
                f"List<{entity}> rows = after == null",
                f"        ? Sql.all(connection, {select(f'{where}{order} LIMIT ?')}, {reader}, limit + 1)",
                f"        : Sql.all(connection, {select(f'{_where([soft, after])}{order} LIMIT ?')}, {reader}{_args(after_values)}, limit + 1);",
                f"List<{entity}> items = new ArrayList<>(rows.subList(0, Math.min(limit, rows.size())));",
                f"{entity} last = items.isEmpty() ? null : items.get(items.size() - 1);",
                f"return new CursorPage<>(items, rows.size() > limit ? List.of({last}) : null);",
            ]
        return [f"return Sql.all(connection, {select(f'{where}{order}')}, {reader});"]
    if kind == "insert":
        imports.add("java.util.ArrayList", "java.util.Collections", "java.util.List")
        written = [column for column in info["columns"] if _writable(column)]
        uuids = [column for column in written if column["column"].get("generated") == "uuid"]
        if uuids:
            imports.add("java.util.UUID")
        key = info["key"]
        identity = key[0] if len(key) == 1 and key[0]["column"].get("generated") == "identity" else None
        into = f"INSERT INTO {_table(context, info)}"
        empty = " () VALUES ()" if context["settings"]["database"] in ("mysql", "mariadb") else " DEFAULT VALUES"
        # Values left null take the database's default
        prepare = [
            *(
                f"if (entity.{column['getter']}() == null) entity.{column['setter']}(UUID.randomUUID());"
                for column in uuids
            ),
            "List<String> names = new ArrayList<>();",
            "List<Object> values = new ArrayList<>();",
            *(
                f"if (entity.{column['getter']}() != null) {{ names.add({java_string(_q(context, column['column']['name']))}); values.add(entity.{column['getter']}()); }}"
                for column in written
            ),
            "String sql = names.isEmpty()",
            f"        ? {java_string(into + empty)}",
            f'        : {java_string(into + " (")} + String.join(", ", names) + ") VALUES (" + String.join(", ", Collections.nCopies(names.size(), "?")) + ")";',
        ]
        if _returns(context):
            return _write(
                context,
                info,
                [
                    *prepare,
                    'return Sql.one(connection, sql + " RETURNING " + COLUMNS, (row) -> fill(row, entity), values.toArray())',
                    f'        .orElseThrow(() -> new IllegalStateException("The {entity} just written is not there"));',
                ],
                imports,
            )
        return _write(
            context,
            info,
            [
                *prepare,
                "Long id = Sql.insert(connection, sql, values.toArray());"
                if identity
                else "Sql.insert(connection, sql, values.toArray());",
                identity
                and f"if (entity.{identity['getter']}() == null && id != null) entity.{identity['setter']}({_from_id(identity['java'])});",
            ],
            imports,
            _read_back(context, info),
        )
    if kind == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        sets = [
            *(f"{_q(context, column['column']['name'])} = ?" for column in changes),
            *(f"{_q(context, column['column']['name'])} = CURRENT_TIMESTAMP" for column in stamps),
        ]
        if not sets:
            return _read_back(context, info)
        sql = f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where(_equals(context, info['key']))}"
        values = [*(f"entity.{column['getter']}()" for column in changes), *_key_values(info)]
        return _write(
            context,
            info,
            [f"Sql.run(connection, {java_string(sql)}{_args(values)});"],
            imports,
            _read_back(context, info),
        )
    if kind == "delete":
        sql = java_string(f"DELETE{from_}{_where(_equals(context, info['key']))}")
        return _write(context, info, [f"Sql.run(connection, {sql}{_args(_key_values(info))});"], imports)
    return ["throw new UnsupportedOperationException();"]
