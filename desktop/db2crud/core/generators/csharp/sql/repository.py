"""The repositories without an ORM: each one writes its SQL and runs it through Db, over one connection and its transaction.
Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or
after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a
database refusal becomes a ConflictException. Mirrors web/src/core/generators/csharp/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..context import column_of, is_in
from ..csharp import CsUsings, cs_string
from .database import read_column, write_value

# The types of PostgreSQL that Npgsql gives as a text only when the database turns them into one
_AS_TEXT = ("enum", "array", "unknown")


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
    return context["settings"]["database"] in ("postgresql", "sqlite")


def _select_list(context: dict, info: dict) -> str:
    """ "id", "name": the columns every read selects, in the order Fill reads them."""
    postgres = context["settings"]["database"] == "postgresql"
    return ", ".join(
        _q(context, column["column"]["name"])
        + ("::text" if postgres and column["column"]["type"]["kind"] in _AS_TEXT else "")
        for column in info["columns"]
    )


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


def _equals(context: dict, columns: list[dict], first: int = 0) -> list[str]:
    """ "id" = @p1, with the markers numbered after the first ones."""
    return [f"{_q(context, column['column']['name'])} = @p{first + index + 1}" for index, column in enumerate(columns)]


def _order_by(context: dict, info: dict) -> str:
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _args(values: list[str]) -> str:
    """The arguments after the others: the values of the statement."""
    return "".join(f", {value}" for value in values)


def _given(context: dict, column: dict, usings: CsUsings) -> str:
    """The property of entity, as the statement takes it."""
    return write_value(context, column, f"entity.{column['prop']}", column["optional"], usings)


def _key_values(context: dict, info: dict, usings: CsUsings) -> list[str]:
    return [_given(context, column, usings) for column in info["key"]]


def sql_head(context: dict, info: dict) -> list:
    """The columns a read selects."""
    return [
        "    /// <summary>The columns every read selects.</summary>",
        f"    private const string Columns = {cs_string(_select_list(context, info))};",
    ]


def sql_tail(context: dict, info: dict, usings: CsUsings) -> list:
    """How a row read with Columns becomes an entity."""
    usings.add("System.Data.Common")
    entity = info["entity"]
    return [
        "",
        f"    /// <summary>The {entity} of a row read with Columns.</summary>",
        f"    private static {entity} ToEntity(DbDataReader row) => Fill(row, new {entity}());",
        "",
        "    /// <summary>Reads a row selected with Columns into entity.</summary>",
        f"    private static {entity} Fill(DbDataReader row, {entity} entity)",
        "    {",
        *(
            f"        entity.{column['prop']} = {read_column(context, column, index, usings)};"
            for index, column in enumerate(info["columns"])
        ),
        "        return entity;",
        "    }",
    ]


def _write(info: dict, action: list[str], after: list[str] | None = None) -> list[str]:
    """A write, with a refusal of the database turned into a ConflictException."""
    return [
        "try",
        "{",
        *(f"    {line}" for line in action),
        "}",
        "catch (RefusedException error)",
        "{",
        f'    throw new ConflictException({cs_string(info["entity"])}, $"the database refused the change: {{error.Message}}");',
        "}",
        *(after or []),
    ]


def _read_back(context: dict, info: dict, usings: CsUsings) -> list[str]:
    """Reads a stored row again by its key, without the soft-delete filter, into the entity."""
    sql = cs_string(f" FROM {_table(context, info)}{_where(_equals(context, info['key']))}")
    values = _args(_key_values(context, info, usings))
    return [
        f'return await db.OneAsync("SELECT " + Columns + {sql}, row => Fill(row, entity){values})',
        f'    ?? throw new InvalidOperationException("The {info["entity"]} just written is not there");',
    ]


def _is_given(info: dict, column: dict) -> str | None:
    """When a new row gives the column its value: the others take the database's default."""
    target = f"entity.{column['prop']}"
    if column["optional"]:
        return f"{target} is not null"
    filled = column["column"].get("generated") is not None or column["column"].get("default") is not None
    if not is_in(column, info["key"]) or not filled:
        return None
    return f"{target} != default" if column["valueType"] else f"{target} is not null"


def _insert_lines(context: dict, info: dict, usings: CsUsings) -> list[str]:
    """The names and the values of an insert, and its SQL."""
    written = [column for column in info["columns"] if _writable(column)]
    into = f"INSERT INTO {_table(context, info)}"
    empty = " DEFAULT VALUES" if _returns(context) else " () VALUES ()"
    result = []
    for column in written:
        if column["column"].get("generated") == "uuid" and column["cs"] == "Guid":
            target = f"entity.{column['prop']}"
            result.append(
                f"{target} ??= Guid.NewGuid();"
                if column["optional"]
                else f"if ({target} == Guid.Empty) {target} = Guid.NewGuid();"
            )
    result += ["var names = new List<string>();", "var values = new List<object?>();"]
    for column in written:
        condition = _is_given(info, column)
        name = cs_string(_q(context, column["column"]["name"]))
        add = f"names.Add({name}); values.Add({_given(context, column, usings)});"
        result.append(f"if ({condition}) {{ {add} }}" if condition else add)
    insert = f'{cs_string(into + " (")} + string.Join(", ", names) + ") VALUES (" + Db.Markers(names.Count) + ")";'
    if all(_is_given(info, column) is not None for column in written):
        return [*result, "var sql = names.Count == 0", f"    ? {cs_string(into + empty)}", f"    : {insert}"]
    return [*result, f"var sql = {insert}"]


def sql_body(context: dict, info: dict, method: dict, usings: CsUsings) -> list[str]:
    entity = info["entity"]
    from_ = f" FROM {_table(context, info)}"

    def select(rest: str) -> str:
        return f'"SELECT " + Columns + {cs_string(from_ + rest)}'

    columns = [column_of(info, name) for name in method["query"]["columns"]]
    by_values = _args([write_value(context, column, column["local"], False, usings) for column in columns])
    soft = _soft_condition(context, info)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    order = _order_by(context, info)
    if kind in ("getByKey", "findByUnique"):
        return [f"return await db.OneAsync({select(_where([*_equals(context, columns), soft]))}, ToEntity{by_values});"]
    if kind in ("listByParent", "findAllBy"):
        rest = _where([*_equals(context, columns), soft]) + order
        return [f"return await db.AllAsync({select(rest)}, ToEntity{by_values});"]
    if kind == "list":
        where = _where([soft])
        if paging == "offset":
            return [
                f"var items = await db.AllAsync({select(f'{where}{order} LIMIT @p1 OFFSET @p2')}, ToEntity, limit, offset);",
                f"var total = await db.OneAsync({cs_string(f'SELECT COUNT(*){from_}{where}')}, row => row.GetInt64(0));",
                f"return new Page<{entity}>(items, total, offset, limit);",
            ]
        if paging == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            markers = [f"@p{index + 1}" for index in range(len(key))]
            after = f"{key[0]} > {markers[0]}" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join(markers)})"
            after_values = []
            for index, column in enumerate(info["key"]):
                plain = f"after[{index}]"
                cast = f"(({column['cs']}){plain})"
                value = write_value(context, column, cast, False, usings)
                after_values.append(plain if value == cast else value)
            last = ", ".join(f"items[^1].{column['prop']}" for column in info["key"])
            rest = f"{_where([soft, after])}{order} LIMIT @p{len(key) + 1}"
            return [
                "var rows = after is null",
                f"    ? await db.AllAsync({select(f'{where}{order} LIMIT @p1')}, ToEntity, limit + 1)",
                f"    : await db.AllAsync({select(rest)}, ToEntity{_args(after_values)}, limit + 1);",
                "var items = rows.Take(limit).ToList();",
                f"return new CursorPage<{entity}>(items, rows.Count > limit ? [{last}] : null);",
            ]
        return [f"return await db.AllAsync({select(f'{where}{order}')}, ToEntity);"]
    if kind == "insert":
        prepare = _insert_lines(context, info, usings)
        if _returns(context):
            return [
                *prepare,
                *_write(
                    info,
                    [
                        'return await db.OneAsync(sql + " RETURNING " + Columns, row => Fill(row, entity), values.ToArray())',
                        f'    ?? throw new InvalidOperationException("The {entity} just written is not there");',
                    ],
                ),
            ]
        key = info["key"]
        identity = key[0] if len(key) == 1 and key[0]["column"].get("generated") == "identity" else None
        if identity:
            number = "id" if identity["cs"] == "long" else f"({identity['cs']})id"
            action = [
                "var id = await db.InsertAsync(sql, values.ToArray());",
                f"if (entity.{identity['prop']} == 0) entity.{identity['prop']} = {number};",
            ]
        else:
            action = ["await db.RunAsync(sql, values.ToArray());"]
        return [*prepare, *_write(info, action, _read_back(context, info, usings))]
    if kind == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        mysql = context["settings"]["database"] in ("mysql", "mariadb")
        now = "CURRENT_TIMESTAMP(6)" if mysql else "CURRENT_TIMESTAMP"
        sets = [
            *_equals(context, changes),
            *(f"{_q(context, column['column']['name'])} = {now}" for column in stamps),
        ]
        if not sets:
            return _read_back(context, info, usings)
        where = _where(_equals(context, info["key"], len(changes)))
        sql = cs_string(f"UPDATE {_table(context, info)} SET {', '.join(sets)}{where}")
        values = [*(_given(context, column, usings) for column in changes), *_key_values(context, info, usings)]
        return _write(info, [f"await db.RunAsync({sql}{_args(values)});"], _read_back(context, info, usings))
    if kind == "delete":
        sql = cs_string(f"DELETE{from_}{_where(_equals(context, info['key']))}")
        return _write(info, [f"await db.RunAsync({sql}{_args(_key_values(context, info, usings))});"])
    return ["throw new NotSupportedException();"]
