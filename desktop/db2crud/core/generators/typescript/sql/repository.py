"""The repositories without an ORM: each one writes its SQL and runs it on a Db (the database or a transaction,
sql/database.py). Rows become the project's plain entities through the readers each driver needs; reads leave out rows
marked as deleted; pages go by offset or after a key; new rows are read back (with RETURNING, or by their key on MySQL
and MariaDB); and a database refusal becomes a ConflictError. Mirrors web/src/core/generators/typescript/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..common.context import is_in
from ..typescript import TsImports, quote
from .database import dialect_of, mark, read_value, writes_json


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
    return dialect_of(context) != "mysql"


def _select_list(context: dict, info: dict) -> str:
    """ "id", "name": the columns every read selects."""
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


def _equals(context: dict, columns: list[dict], start: int = 0) -> list[str]:
    """ "a" = $1 AND …, numbering the marks from `start`."""
    return [
        f"{_q(context, column['column']['name'])} = {mark(context, start + index)}"
        for index, column in enumerate(columns)
    ]


def _order_by(context: dict, info: dict) -> str:
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _param(context: dict, column: dict, value: str, imports: TsImports) -> str:
    """A value of the entity as the driver writes it."""
    if not writes_json(context, column["column"]["type"]):
        return value
    imports.from_("src/database", "toJson")
    return f"toJson({value})"


def _params(values: list[str]) -> str:
    return f"[{', '.join(values)}]"


def _key_params(context: dict, info: dict, imports: TsImports, target: str = "entity") -> str:
    """The key of the entity as the parameters of a query."""
    return _params([_param(context, column, f"{target}.{column['prop']}", imports) for column in info["key"]])


def sql_helpers(context: dict, info: dict, imports: TsImports) -> list:
    """The constant of the columns a read selects, and the entity of a row."""
    imports.type("src/database", "Row")
    values = []
    for column in info["columns"]:
        expression, reader = read_value(context, column["column"]["type"], f"row[{quote(column['column']['name'])}]")
        if reader:
            imports.from_("src/database", reader)
        nullable = " | null" if column["column"]["nullable"] else ""
        values.append(f"    {column['prop']}: {expression} as {column['ts']}{nullable},")
    entity = info["entity"]
    return [
        "/** The columns every read selects. */",
        f"const COLUMNS = {quote(_select_list(context, info))}",
        "",
        f"/** The {entity} of a row read with COLUMNS. */",
        f"function toEntity(row: Row): {entity} {{",
        f"  return Object.assign(new {entity}(), {{",
        *values,
        "  })",
        "}",
    ]


def _write(info: dict, action: list, imports: TsImports, after: list | None = None) -> list:
    """A write, with a refusal of the database turned into a ConflictError."""
    imports.from_("src/database", "isRefusal").from_("src/errors", "ConflictError")
    return [
        "try {",
        *(f"  {line}" if isinstance(line, str) else line for line in action),
        "} catch (error) {",
        f"  if (isRefusal(error)) throw new ConflictError('{info['entity']}', "
        "`the database refused the change: ${(error as Error).message}`)",
        "  throw error",
        "}",
        *(after or []),
    ]


def _read_back(context: dict, info: dict, imports: TsImports) -> list:
    """Reads a stored row again by its key, without the soft-delete filter, into the entity."""
    sql = quote(f" FROM {_table(context, info)}{_where(_equals(context, info['key']))}")
    return [
        f"const row = await this.db.one('SELECT ' + COLUMNS + {sql}, {_key_params(context, info, imports)})",
        f"if (row === null) throw new Error('The {info['entity']} just written is not there')",
        "return Object.assign(entity, toEntity(row))",
    ]


def sql_body(context: dict, info: dict, method: dict, imports: TsImports) -> list:
    from_ = f" FROM {_table(context, info)}"

    def select(rest: str) -> str:
        return f"'SELECT ' + COLUMNS + {quote(from_ + rest)}"

    by_columns = [
        next(column for column in info["columns"] if column["column"]["name"] == name)
        for name in method["query"]["columns"]
    ]
    by_params = _params([_param(context, column, column["prop"], imports) for column in by_columns])
    soft = _soft_condition(context, info)
    kind = method["query"]["kind"]
    paging = context["settings"]["paging"]
    if kind in ("getByKey", "findByUnique"):
        return [
            f"const row = await this.db.one({select(_where([*_equals(context, by_columns), soft]))}, {by_params})",
            "return row === null ? null : toEntity(row)",
        ]
    if kind in ("listByParent", "findAllBy"):
        rest = _where([*_equals(context, by_columns), soft]) + _order_by(context, info)
        return [f"const rows = await this.db.all({select(rest)}, {by_params})", "return rows.map(toEntity)"]
    if kind == "list":
        where = _where([soft])
        order = _order_by(context, info)
        if paging == "offset":
            return [
                f"const rows = await this.db.all({select(f'{where}{order} LIMIT {mark(context, 0)} OFFSET {mark(context, 1)}')}, [limit, offset])",
                f"const counted = await this.db.one({quote(f'SELECT COUNT(*) AS total{from_}{where}')})",
                "return { items: rows.map(toEntity), total: Number(counted?.total ?? 0), offset, limit }",
            ]
        if paging == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            marks = [mark(context, index) for index in range(len(info["key"]))]
            after = f"{key[0]} > {marks[0]}" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join(marks)})"
            first = select(f"{where}{order} LIMIT {mark(context, 0)}")
            later = select(f"{_where([soft, after])}{order} LIMIT {mark(context, len(info['key']))}")
            last = ", ".join(f"last.{column['prop']}" for column in info["key"])
            return [
                "const rows =",
                "  after === null",
                f"    ? await this.db.all({first}, [limit + 1])",
                f"    : await this.db.all({later}, [...after, limit + 1])",
                "const items = rows.slice(0, limit).map(toEntity)",
                "const last = items[items.length - 1]",
                f"return {{ items, next: rows.length > limit ? [{last}] : null }}",
            ]
        return [f"const rows = await this.db.all({select(f'{where}{order}')})", "return rows.map(toEntity)"]
    if kind == "insert":
        columns = [column for column in info["columns"] if _writable(column)]
        uuids = [column for column in columns if column["column"].get("generated") == "uuid"]
        if uuids:
            imports.from_("node:crypto", "randomUUID")
        key = info["key"]
        identity = key[0] if len(key) == 1 and key[0]["column"].get("generated") == "identity" else None
        into = f"INSERT INTO {_table(context, info)}"
        numbered = dialect_of(context) == "postgresql"
        # Values left undefined take the database's default
        prepare = [
            *(f"if (entity.{column['prop']} === undefined) entity.{column['prop']} = randomUUID()" for column in uuids),
            "const given = (",
            "  [",
            *(
                f"    [{quote(_q(context, column['column']['name']))}, {_param(context, column, 'entity.' + column['prop'], imports)}],"
                for column in columns
            ),
            "  ] as [string, unknown][]",
            ").filter(([, value]) => value !== undefined)",
            "const names = given.map(([name]) => name).join(', ')",
            "const marks = given.map((_, index) => `$${index + 1}`).join(', ')"
            if numbered
            else "const marks = given.map(() => '?').join(', ')",
            "const values = given.map(([, value]) => value)",
        ]
        if _returns(context):
            return _write(
                info,
                [
                    *prepare,
                    "const sql =",
                    "  given.length > 0",
                    f"    ? {quote(into + ' (')} + names + ') VALUES (' + marks + ') RETURNING ' + COLUMNS",
                    f"    : {quote(into + ' DEFAULT VALUES RETURNING ')} + COLUMNS",
                    "const row = await this.db.one(sql, values)",
                    f"if (row === null) throw new Error('The {info['entity']} just written is not there')",
                    "return Object.assign(entity, toEntity(row))",
                ],
                imports,
            )
        return _write(
            info,
            [
                *prepare,
                f"const id = await this.db.run({quote(into + ' (')} + names + ') VALUES (' + marks + ')', values)",
                identity
                and f"if (entity.{identity['prop']} === undefined) entity.{identity['prop']} = id as {identity['ts']}",
            ],
            imports,
            _read_back(context, info, imports),
        )
    if kind == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        sets = [
            *(
                f"{_q(context, column['column']['name'])} = {mark(context, index)}"
                for index, column in enumerate(changes)
            ),
            *(f"{_q(context, column['column']['name'])} = CURRENT_TIMESTAMP" for column in stamps),
        ]
        if not sets:
            return _read_back(context, info, imports)
        values = _params(
            [
                *(_param(context, column, f"entity.{column['prop']}", imports) for column in changes),
                *(_param(context, column, f"entity.{column['prop']}", imports) for column in info["key"]),
            ]
        )
        sql = (
            f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where(_equals(context, info['key'], len(changes)))}"
        )
        return _write(info, [f"await this.db.run({quote(sql)}, {values})"], imports, _read_back(context, info, imports))
    if kind == "delete":
        sql = quote(f"DELETE{from_}{_where(_equals(context, info['key']))}")
        return _write(info, [f"await this.db.run({sql}, {_key_params(context, info, imports)})"], imports)
    return ["throw new Error('not written')"]
