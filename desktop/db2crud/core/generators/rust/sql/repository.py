"""* The repositories without an ORM: each one writes its SQL and runs it through sqlx on Db (the pool, or a transaction).
Rows are read into the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or
after a key; new rows are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a
database refusal becomes a Conflict. Mirrors
web/src/core/generators/rust/sql/repository.ts."""

import re

from ....schema.ddl import quote_name, table_name
from ..context import column_of, is_in, stored
from ..repositories import key_value
from ..rust import RsUses, rs_string
from .database import cast, read_column, reads_decimals, selected, write_value


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


def _mark(context: dict, column: dict, position: int):
    """The mark of the value at a position: $1::"mood", or ?."""
    return f"${position}{cast(context, column)}" if context["settings"]["database"] == "postgresql" else "?"


def _number_mark(context: dict, position: int):
    """The mark of a number at a position."""
    return f"${position}" if context["settings"]["database"] == "postgresql" else "?"


def _soft_condition(context: dict, info: dict) -> str | None:
    """The condition that leaves out rows marked as deleted."""
    if not info["soft"]:
        return None
    column = _q(context, info["soft"]["column"]["name"])
    return f"{column} = FALSE" if info["soft"]["column"]["type"]["kind"] == "boolean" else f"{column} IS NULL"


def _where_sql(conditions: list) -> str:
    present = [item for item in conditions if item is not None]
    return f" WHERE {' AND '.join(present)}" if len(present) > 0 else ""


def _equals(context: dict, columns: list[dict], first=0):
    """ "id" = $1, with the marks numbered after the first ones."""
    return [
        f"{_q(context, column['column']['name'])} = {_mark(context, column, first + index + 1)}"
        for index, column in enumerate(columns)
    ]


def _order_by(context: dict, info: dict):
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _binds(values: list[str]):
    """The calls that bind values to a statement."""
    return "".join(f".bind({value})" for value in values)


def _key_values(context: dict, info: dict):
    """The key of an entity known to be stored, as the statement takes it."""
    return [
        (
            _optional(context, column)
            if column["column"]["nullable"]
            else write_value(context, column, stored(f"entity.{column['field']}", column))
        )
        for column in info["key"]
    ]


def _optional(context: dict, column: dict) -> str:
    """A field of the entity, which may be None, as the statement takes it."""
    field = f"entity.{column['field']}" if column["copy"] else f"entity.{column['field']}.clone()"
    value = write_value(context, column, "value")
    return field if value == "value" else f"{field}.map(|value| {value})"


def sql_helpers(context: dict, info: dict, methods: list, uses: RsUses) -> list[str]:
    """The functions after the struct: the columns a read selects, how a row becomes an entity, and how writes report a refusal."""
    reads = any(method["query"]["kind"] != "delete" for method in methods)
    writes = any(method["query"]["kind"] in ["insert", "update", "delete"] for method in methods)
    if reads:
        uses.add("sqlx::Row", "crate::database::DbRow")
    if writes:
        uses.add("sqlx::error::ErrorKind")
    columns = ", ".join(selected(context, column) for column in info["columns"])
    return [
        *(
            [
                "",
                "/// The columns every read selects.",
                f"const COLUMNS: &str = {rs_string(columns)};",
                "",
                "/// The entity of a row read with COLUMNS.",
                f"fn to_entity(row: &DbRow) -> Result<{info['entity']}, sqlx::Error> {{",
                f"    Ok({info['entity']} {{",
                *(
                    f"        {column['field']}: {read_column(context, column, index)},"
                    for index, column in enumerate(info["columns"])
                ),
                "    })",
                "}",
                "",
                "/// The entities of the rows read with COLUMNS.",
                f"fn to_entities(rows: Vec<DbRow>) -> Result<Vec<{info['entity']}>, sqlx::Error> {{",
                "    rows.iter().map(to_entity).collect()",
                "}",
            ]
            if reads
            else []
        ),
        *(
            [
                "",
                "/// A decimal, which SQLite keeps as a number, with the scale of its column.",
                "fn decimal(text: &str, scale: Option<u32>) -> Result<rust_decimal::Decimal, sqlx::Error> {",
                "    let mut value = text",
                "        .parse::<rust_decimal::Decimal>()",
                "        .or_else(|_| rust_decimal::Decimal::from_scientific(text))",
                "        .map_err(|error| sqlx::Error::Decode(Box::new(error)))?;",
                "    if let Some(scale) = scale {",
                "        value.rescale(scale);",
                "    }",
                "    Ok(value)",
                "}",
            ]
            if reads and reads_decimals(context, info)
            else []
        ),
        *(
            [
                "",
                "/// A refusal of the database (a unique value, a row still pointed to) becomes a Conflict.",
                "fn refused(error: sqlx::Error) -> DomainError {",
                "    if error.as_database_error().is_some_and(|refusal| !matches!(refusal.kind(), ErrorKind::Other)) {",
                f'        DomainError::conflict({rs_string(info["entity"])}, &format!("the database refused the change: {{error}}"), &[])',
                "    } else {",
                "        error.into()",
                "    }",
                "}",
            ]
            if writes
            else []
        ),
    ]


def _select(rest: str, values: list[str]):
    """The statement that reads the rows of a FROM, with its values."""
    text = re.sub(r"\}", "}}", re.sub(r"\{", "{{", rest))
    return "statement(format!(" + rs_string(f"SELECT {{COLUMNS}}{text}") + f")){_binds(values)}"


def _read_back(context: dict, info: dict) -> list[str]:
    """Reads a stored row again by its key, without the soft-delete filter."""
    rest = f" FROM {_table(context, info)}{_where_sql(_equals(context, info['key']))}"
    return [
        f"let query = {_select(rest, _key_values(context, info))};",
        "let row = self.db.one(query).await?.ok_or(sqlx::Error::RowNotFound)?;",
        "Ok(to_entity(&row)?)",
    ]


def _insert_lines(context: dict, info: dict) -> list[str]:
    """The statement of an insert: columns left None take the database's default."""
    written = [column for column in info["columns"] if _writable(column)]
    uuids = [
        column for column in written if column["column"].get("generated") == "uuid" and column["rs"] == "uuid::Uuid"
    ]
    identity = (
        len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity" and not _returns(context)
    )

    def given(column: dict):
        name = rs_string(_q(context, column["column"]["name"]))
        return (
            f"({name}, {rs_string(cast(context, column))})" if context["settings"]["database"] == "postgresql" else name
        )

    def taken(column: dict):
        return f"entity.{column['field']}" if column["copy"] else f"entity.{column['field']}.clone()"

    return [
        *(["let mut entity = entity;"] if len(uuids) > 0 or identity else []),
        *(
            f"entity.{column['field']} = entity.{column['field']}.or_else(|| Some(uuid::Uuid::new_v4()));"
            for column in uuids
        ),
        "let mut given = Vec::new();",
        *(
            line
            for column in written
            for line in [f"if entity.{column['field']}.is_some() {{", f"    given.push({given(column)});", "}"]
        ),
        f"let sql = insert_sql({rs_string(_table(context, info))}, &given);",
        (
            "let mut query = statement("
            + ('format!("{sql} RETURNING {COLUMNS}")' if _returns(context) else "sql")
            + ");"
        ),
        *(
            line
            for column in written
            for line in [
                f"if let Some(value) = {taken(column)} {{",
                f"    query = query.bind({write_value(context, column, 'value')});",
                "}",
            ]
        ),
    ]


def sql_body(context: dict, info: dict, method: dict, uses: RsUses) -> list[str]:
    uses.add("crate::database::statement")
    from_ = f" FROM {_table(context, info)}"
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    by_values = [write_value(context, column, column["field"]) for column in columns]
    soft = _soft_condition(context, info)
    order = _order_by(context, info)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [
            ("let query = " + _select(f"{from_}{_where_sql([*_equals(context, columns), soft])}", by_values) + ";"),
            "let row = self.db.one(query).await?;",
            "Ok(row.as_ref().map(to_entity).transpose()?)",
        ]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [
            (
                "let query = "
                + _select(f"{from_}{_where_sql([*_equals(context, columns), soft])}{order}", by_values)
                + ";"
            ),
            "Ok(to_entities(self.db.all(query).await?)?)",
        ]
    if method["query"]["kind"] == "list":
        where = _where_sql([soft])
        if context["settings"]["paging"] == "offset":
            uses.add("sqlx::Row")
            limits = f" LIMIT {_number_mark(context, 1)} OFFSET {_number_mark(context, 2)}"
            return [
                ("let query = " + _select(f"{from_}{where}{order}{limits}", ["limit as i64", "offset as i64"]) + ";"),
                "let items = to_entities(self.db.all(query).await?)?;",
                (
                    "let count = self.db.one(statement("
                    + rs_string(f"SELECT COUNT(*){from_}{where}")
                    + ")).await?.ok_or(sqlx::Error::RowNotFound)?;"
                ),
                "let total = count.try_get::<i64, _>(0)? as u64;",
                "Ok(Page { items, total, offset, limit })",
            ]
        if context["settings"]["paging"] == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            marks = [_mark(context, column, index + 1) for index, column in enumerate(info["key"])]
            after = f"{key[0]} > {marks[0]}" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join(marks)})"
            names = ["after"] if len(info["key"]) == 1 else [f"after{index}" for index, _ in enumerate(info["key"])]
            values = [write_value(context, column, names[index]) for index, column in enumerate(info["key"])]
            first = _select(f"{from_}{where}{order} LIMIT {_number_mark(context, 1)}", ["limit as i64 + 1"])
            next = _select(
                f"{from_}{_where_sql([soft, after])}{order} LIMIT {_number_mark(context, len(key) + 1)}",
                [*values, "limit as i64 + 1"],
            )
            return [
                "let query = match after {",
                f"    None => {first},",
                ("    Some(" + ("after" if len(names) == 1 else f"({', '.join(names)})") + f") => {next},"),
                "};",
                "let mut items = to_entities(self.db.all(query).await?)?;",
                "let more = items.len() as u64 > limit;",
                "items.truncate(limit as usize);",
                f"let next = if more {{ items.last().map(|last| {key_value(info, 'last')}) }} else {{ None }};",
                "Ok(CursorPage { items, next })",
            ]
        return [
            ("let query = " + _select(f"{from_}{where}{order}", []) + ";"),
            "Ok(to_entities(self.db.all(query).await?)?)",
        ]
    if method["query"]["kind"] == "insert":
        uses.add("crate::database::insert_sql")
        prepare = _insert_lines(context, info)
        if _returns(context):
            return [
                *prepare,
                "let row = self.db.one(query).await.map_err(refused)?.ok_or(sqlx::Error::RowNotFound)?;",
                "Ok(to_entity(&row)?)",
            ]
        identity = (
            info["key"][0]
            if len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity"
            else None
        )
        return [
            *prepare,
            f"{('let result = ' if identity else '')}self.db.run(query).await.map_err(refused)?;",
            *(
                [
                    f"entity.{identity['field']} = entity.{identity['field']}.or(Some(result.last_insert_id() as {identity['rs']}));"
                ]
                if identity
                else []
            ),
            *_read_back(context, info),
        ]
    if method["query"]["kind"] == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        now = "CURRENT_TIMESTAMP" if _returns(context) else "CURRENT_TIMESTAMP(6)"
        sets = [*_equals(context, changes), *(f"{_q(context, column['column']['name'])} = {now}" for column in stamps)]
        if len(sets) == 0:
            return _read_back(context, info)
        sql = rs_string(
            f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where_sql(_equals(context, info['key'], len(changes)))}"
        )
        values = [*(_optional(context, column) for column in changes), *_key_values(context, info)]
        return [
            f"let query = statement({sql}){_binds(values)};",
            "self.db.run(query).await.map_err(refused)?;",
            *_read_back(context, info),
        ]
    if method["query"]["kind"] == "delete":
        sql = rs_string(f"DELETE{from_}{_where_sql(_equals(context, info['key']))}")
        return [
            f"let query = statement({sql}){_binds(_key_values(context, info))};",
            "self.db.run(query).await.map_err(refused)?;",
            "Ok(())",
        ]
    return ["unimplemented!()"]
