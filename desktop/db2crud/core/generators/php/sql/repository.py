"""* The repositories without an ORM: each one writes its SQL and runs it through Sql over a PDO connection. Rows are read into
the plain entities column by column; reads leave out rows marked as deleted; pages go by offset or after a key; new rows
are read back (with RETURNING on PostgreSQL and SQLite, by their key on MySQL and MariaDB); and a database refusal becomes
a ConflictException. Mirrors
web/src/core/generators/php/sql/repository.ts."""

from ....schema.ddl import quote_name, table_name
from ..common.context import column_of, error_class, is_in
from ..common.php import PhpUses, access, php_string
from ..common.repositories import uuid_fills
from .database import read_column, selected, sql_uses, write_value


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
    return [f"{_q(context, column['column']['name'])} = ?" for column in columns]


def _order_by(context: dict, info: dict):
    return f" ORDER BY {', '.join(_q(context, column['column']['name']) for column in info['key'])}"


def _args(values: list[str]):
    """The last argument of a call: the values of the statement."""
    return f", [{', '.join(values)}]" if len(values) > 0 else ""


def _given(context: dict, column: dict):
    """The property of the entity, as the statement takes it."""
    return write_value(context, column, access("$entity", column["prop"]), True)


def _key_values(context: dict, info: dict):
    return [_given(context, column) for column in info["key"]]


def _write(call: str):
    """A write that a refusal of the database turns into a ConflictException."""
    return f"$this->write(fn () => {call})"


def sql_init(context: dict, info: dict, uses: PhpUses) -> list:
    """The constructor, after the columns a read selects."""
    sql_uses(context, uses)
    columns = ", ".join(selected(context, column, _q(context, column["column"]["name"])) for column in info["columns"])
    return [
        "    /** The columns every read selects */",
        f"    private const COLUMNS = {php_string(columns)};",
        "",
        "    public function __construct(private readonly PDO $db)",
        "    {",
        "    }",
    ]


def sql_helpers(context: dict, info: dict, uses: PhpUses) -> list:
    """How a row read with COLUMNS becomes an entity, and how writes report a refusal."""
    kinds = {item["kind"] for item in info["queries"]}
    writes = "insert" in kinds or "update" in kinds or "delete" in kinds
    if writes:
        uses.add("PDOException", error_class(context, "ConflictException"))
    return [
        "    /**",
        "     * Reads a row selected with COLUMNS into $entity.",
        "     *",
        "     * @param list<mixed> $row",
        "     */",
        f"    private static function fill({info['entity']} $entity, array $row): {info['entity']}",
        "    {",
        *(
            (f"        {access('$entity', column['prop'])} = " + read_column(context, column, f"$row[{index}]") + ";")
            for index, column in enumerate(info["columns"])
        ),
        "        return $entity;",
        "    }",
        "",
        "    /**",
        "     * The rows of a query that selects COLUMNS.",
        "     *",
        "     * @param list<mixed> $values",
        f"     * @return list<{info['entity']}>",
        "     */",
        "    private function rows(string $rest, array $values = []): array",
        "    {",
        "        $sql = 'SELECT ' . self::COLUMNS . $rest;",
        f"        return array_map(fn (array $row) => self::fill(new {info['entity']}(), $row), Sql::all($this->db, $sql, $values));",
        "    }",
        *(
            [
                "",
                "    /** Runs a write; a database refusal (a unique value, a row still pointed to) becomes a ConflictException. */",
                "    private function write(callable $change): mixed",
                "    {",
                "        try {",
                "            return $change();",
                "        } catch (PDOException $error) {",
                "            if (!Sql::isRefusal($error)) {",
                "                throw $error;",
                "            }",
                f"            throw new ConflictException({php_string(info['entity'])}, 'the database refused the change: ' . $error->getMessage());",
                "        }",
                "    }",
            ]
            if writes
            else []
        ),
    ]


def _read_back(context: dict, info: dict) -> list:
    """Reads a stored row again by its key, without the soft-delete filter, into the entity."""
    rest = php_string(f" FROM {_table(context, info)}{_where_sql(_equals(context, info['key']))}")
    return [
        f"$row = Sql::one($this->db, 'SELECT ' . self::COLUMNS . {rest}{_args(_key_values(context, info))});",
        (
            "return self::fill($entity, $row ?? throw new \\LogicException("
            + php_string(f"The {info['entity']} just written is not there")
            + "));"
        ),
    ]


def sql_body(context: dict, info: dict, method: dict, uses: PhpUses) -> list:
    from_ = f" FROM {_table(context, info)}"
    columns = [column_of(info, name) for name in method["query"]["columns"]]
    by_values = _args([write_value(context, column, f"${column['field']}", False) for column in columns])
    soft = _soft_condition(context, info)
    order = _order_by(context, info)
    if method["query"]["kind"] in ("getByKey", "findByUnique"):
        return [
            (
                "return $this->rows("
                + php_string(f"{from_}{_where_sql([*_equals(context, columns), soft])}")
                + f"{by_values})[0] ?? null;"
            )
        ]
    if method["query"]["kind"] in ("listByParent", "findAllBy"):
        return [
            (
                "return $this->rows("
                + php_string(f"{from_}{_where_sql([*_equals(context, columns), soft])}{order}")
                + f"{by_values});"
            )
        ]
    if method["query"]["kind"] == "list":
        where = _where_sql([soft])
        if context["settings"]["paging"] == "offset":
            return [
                (
                    "$items = $this->rows("
                    + php_string(f"{from_}{where}{order} LIMIT ? OFFSET ?")
                    + ", [$limit, $offset]);"
                ),
                ("$total = (int) Sql::one($this->db, " + php_string(f"SELECT COUNT(*){from_}{where}") + ")[0];"),
                "return new Page($items, $total, $offset, $limit);",
            ]
        if context["settings"]["paging"] == "cursor":
            key = [_q(context, column["column"]["name"]) for column in info["key"]]
            after = f"{key[0]} > ?" if len(key) == 1 else f"({', '.join(key)}) > ({', '.join('?' for _ in key)})"
            after_values = [
                write_value(context, column, f"$after[{index}]", False) for index, column in enumerate(info["key"])
            ]
            next = [access("$items[$limit - 1]", column["prop"]) for column in info["key"]]
            return [
                "$rows = $after === null",
                ("    ? $this->rows(" + php_string(f"{from_}{where}{order} LIMIT ?") + ", [$limit + 1])"),
                (
                    "    : $this->rows("
                    + php_string(f"{from_}{_where_sql([soft, after])}{order} LIMIT ?")
                    + f", [{', '.join(after_values)}, $limit + 1]);"
                ),
                "$items = array_slice($rows, 0, $limit);",
                f"return new CursorPage($items, count($rows) > $limit ? [{', '.join(next)}] : null);",
            ]
        return [("return $this->rows(" + php_string(f"{from_}{where}{order}") + ");")]
    if method["query"]["kind"] == "insert":
        into = f"INSERT INTO {_table(context, info)}"
        empty = " DEFAULT VALUES" if _returns(context) else " () VALUES ()"
        # Values left null take the database's default
        prepare = [
            *uuid_fills(context, info, uses),
            "$names = [];",
            "$values = [];",
            *(
                line
                for column in [column for column in info["columns"] if _writable(column)]
                for line in [
                    f"if ({access('$entity', column['prop'])} !== null) {{",
                    f"    $names[] = {php_string(_q(context, column['column']['name']))};",
                    f"    $values[] = {write_value(context, column, access('$entity', column['prop']), False)};",
                    "}",
                ]
            ),
            "$sql = $names === []",
            ("    ? " + php_string(f"{into}{empty}")),
            (
                "    : "
                + php_string(f"{into} (")
                + " . implode(', ', $names) . ') VALUES (' . implode(', ', array_fill(0, count($names), '?')) . ')';"
            ),
        ]
        if _returns(context):
            return [
                *prepare,
                ("$row = " + _write("Sql::one($this->db, $sql . ' RETURNING ' . self::COLUMNS, $values)") + ";"),
                (
                    "return self::fill($entity, $row ?? throw new \\LogicException("
                    + php_string(f"The {info['entity']} just written is not there")
                    + "));"
                ),
            ]
        identity = (
            info["key"][0]
            if len(info["key"]) == 1 and info["key"][0]["column"].get("generated") == "identity"
            else None
        )
        return [
            *prepare,
            f"{_write('Sql::run($this->db, $sql, $values)')};",
            *([f"{access('$entity', identity['prop'])} ??= (int) $this->db->lastInsertId();"] if identity else []),
            *_read_back(context, info),
        ]
    if method["query"]["kind"] == "update":
        changes = [column for column in info["columns"] if _changeable(info, column)]
        stamps = [column for column in info["columns"] if column["column"].get("generated") == "onUpdateNow"]
        now = "CURRENT_TIMESTAMP" if _returns(context) else "CURRENT_TIMESTAMP(6)"
        sets = [*_equals(context, changes), *(f"{_q(context, column['column']['name'])} = {now}" for column in stamps)]
        if len(sets) == 0:
            return _read_back(context, info)
        sql = php_string(
            f"UPDATE {_table(context, info)} SET {', '.join(sets)}{_where_sql(_equals(context, info['key']))}"
        )
        values = [*(_given(context, column) for column in changes), *_key_values(context, info)]
        return [(_write(f"Sql::run($this->db, {sql}{_args(values)})") + ";"), *_read_back(context, info)]
    if method["query"]["kind"] == "delete":
        sql = php_string(f"DELETE{from_}{_where_sql(_equals(context, info['key']))}")
        return [(_write(f"Sql::run($this->db, {sql}{_args(_key_values(context, info))})") + ";")]
    return ["throw new \\LogicException('not supported');"]
