"""* The database layer of a PHP project without an ORM: Database, which opens the database DATABASE_URL names with PDO;
Sql, what the repositories run their SQL with (statements and their values as each driver takes them, and the
database's refusals); and the entities, plain classes with a property per column. Mirrors
web/src/core/generators/php/sql/database.ts."""

from ..common.context import class_name, namespace_of, optional_type, path_of, php_file
from ..common.php import PhpUses, php_string

_URLS = {
    "postgresql": "postgresql://app:app@localhost:5432/app",
    "mysql": "mysql://app:app@localhost:3306/app",
    "mariadb": "mariadb://app:app@localhost:3306/app",
    "sqlite": "sqlite:///app.db",
}


def default_url(context: dict):
    return _URLS.get(context["settings"]["database"], _URLS["postgresql"])


def _is_mysql(context: dict):
    return context["settings"]["database"] == "mysql" or context["settings"]["database"] == "mariadb"


def sql_php_type(type_: dict) -> str:
    """The PHP type of a value as the entities keep it."""
    if type_["kind"] == "integer":
        return "int"
    if type_["kind"] == "float":
        return "float"
    if type_["kind"] == "boolean":
        return "bool"
    if type_["kind"] in ("date", "datetime"):
        return "\\DateTimeImmutable"
    if type_["kind"] in ("json", "array"):
        return "mixed"
    return "string"


def _database_file(context: dict) -> dict:
    """Database: the PDO connection to the database DATABASE_URL names."""
    sqlite = context["settings"]["database"] == "sqlite"
    options = [
        "            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,",
        "            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_NUM,",
        *(
            ["            // Numbers come back as numbers", "            PDO::ATTR_EMULATE_PREPARES => false,"]
            if _is_mysql(context)
            else []
        ),
    ]
    connect = (
        [
            "        $path = substr($url, strlen('sqlite:///'));",
            "        $db = new PDO('sqlite:' . ($path !== '' ? $path : ':memory:'), null, null, [",
            *options,
            "        ]);",
            "        $db->exec('PRAGMA foreign_keys = ON');",
            "        return $db;",
        ]
        if sqlite
        else [
            "        $parts = parse_url($url);",
            "        if ($parts === false || !isset($parts['host'], $parts['path'])) {",
            "            throw new \\InvalidArgumentException('The URL of the database is not valid');",
            "        }",
            (
                "        $dsn = sprintf("
                + (
                    "'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4'"
                    if _is_mysql(context)
                    else "'pgsql:host=%s;port=%d;dbname=%s'"
                )
                + f", $parts['host'], $parts['port'] ?? {('3306' if _is_mysql(context) else '5432')}, ltrim($parts['path'], '/'));"
            ),
            "        return new PDO($dsn, rawurldecode($parts['user'] ?? ''), rawurldecode($parts['pass'] ?? ''), [",
            *options,
            "        ]);",
        ]
    )
    return php_file(
        path_of(context["base"], "Database"),
        context["base"],
        "use PDO;",
        [
            "/** The database DATABASE_URL names, through PDO. */",
            "final class Database",
            "{",
            f"    public const DEFAULT_URL = {php_string(default_url(context))};",
            "",
            "    /** The URL of DATABASE_URL, or the default one. */",
            "    public static function url(): string",
            "    {",
            "        $url = getenv('DATABASE_URL');",
            "        return is_string($url) && $url !== '' ? $url : self::DEFAULT_URL;",
            "    }",
            "",
            "    /** A connection to the database at $url (DATABASE_URL when null). */",
            "    public static function open(?string $url = null): PDO",
            "    {",
            "        $url ??= self::url();",
            *connect,
            "    }",
            "}",
        ],
    )


def _uses_kind(context: dict, kind: dict):
    """Whether a column of the tables has a type of this kind."""
    return any(
        any(column["column"]["type"]["kind"] == kind for column in info["columns"]) for info in context["tables"]
    )


def selected(context: dict, column: dict, name: str) -> str:
    """A column as a read selects it: an array of PostgreSQL comes as JSON."""
    return (
        f"to_json({name})"
        if context["settings"]["database"] == "postgresql" and column["column"]["type"]["kind"] == "array"
        else name
    )


def read_column(context: dict, column: dict, value: str) -> str:
    """A value read from a row, which may be null, as the property keeps it."""
    type_ = column["column"]["type"]
    database = context["settings"]["database"]

    def present(code: str):
        return f"{value} === null ? null : {code}"

    if type_["kind"] == "integer":
        return present(f"(int) {value}")
    if type_["kind"] == "float":
        return present(f"(float) {value}")
    if type_["kind"] == "boolean":
        return present(f"(bool) {value}")
    if type_["kind"] == "decimal":
        # SQLite keeps a decimal as a number: its scale is given back from the column's
        if database == "sqlite" and type_.get("scale") is not None:
            return present(f"number_format((float) {value}, {type_.get('scale')}, '.', '')")
        return present(f"(string) {value}")
    if type_["kind"] == "date":
        return present(f"new \\DateTimeImmutable({value})")
    if type_["kind"] == "datetime":
        # A time without its zone (all of MySQL's, and SQLite's CURRENT_TIMESTAMP) is in UTC
        return present(
            f"new \\DateTimeImmutable({value}, new \\DateTimeZone('UTC'))"
            if type_["timezone"] and database != "postgresql"
            else f"new \\DateTimeImmutable({value})"
        )
    if type_["kind"] in ("json", "array"):
        return present(f"json_decode({value}, true, flags: JSON_THROW_ON_ERROR)")
    if type_["kind"] == "binary":
        return present(f"Sql::bytes({value})") if database == "postgresql" else present(f"(string) {value}")
    return present(f"(string) {value}")


def write_value(context: dict, column: dict, value: str, optional: bool) -> str:
    """A value of the property as the driver takes it."""
    type_ = column["column"]["type"]
    database = context["settings"]["database"]
    arrow = "?->" if optional else "->"

    def present(code: str):
        return f"{value} === null ? null : {code}" if optional else code

    if type_["kind"] == "date":
        return f"{value}{arrow}format('Y-m-d')"
    if type_["kind"] == "datetime":
        if not type_["timezone"]:
            return f"{value}{arrow}format('Y-m-d H:i:s.u')"
        if database == "postgresql":
            return f"{value}{arrow}format('Y-m-d H:i:s.uP')"
        return f"{value}{arrow}setTimezone(new \\DateTimeZone('UTC')){arrow}format('Y-m-d H:i:s.u')"
    if type_["kind"] == "json":
        return present(f"json_encode({value}, JSON_THROW_ON_ERROR)")
    if type_["kind"] == "array":
        return present(
            f"Sql::arrayLiteral({value})" if database == "postgresql" else f"json_encode({value}, JSON_THROW_ON_ERROR)"
        )
    if type_["kind"] == "binary":
        if database == "postgresql":
            return present(f"'\\x' . bin2hex({value})")
        return present(f"Sql::blob({value})") if database == "sqlite" else value
    return value


def _sql_file(context: dict) -> dict:
    """Sql: what the repositories run their SQL with."""
    database = context["settings"]["database"]
    postgres = database == "postgresql"
    sqlite = database == "sqlite"
    blobs = sqlite and _uses_kind(context, "binary")
    body = [
        "/** What the repositories run their SQL with, over PDO: statements and their values, and the database's refusals. */",
        "final class Sql",
        "{",
        "    /**",
        "     * Every row of a query, as the list of its columns.",
        "     *",
        "     * @param list<mixed> $values",
        "     * @return list<list<mixed>>",
        "     */",
        "    public static function all(PDO $db, string $sql, array $values = []): array",
        "    {",
        "        return self::run($db, $sql, $values)->fetchAll(PDO::FETCH_NUM);",
        "    }",
        "",
        "    /**",
        "     * The first row of a query, or null.",
        "     *",
        "     * @param list<mixed> $values",
        "     * @return list<mixed>|null",
        "     */",
        "    public static function one(PDO $db, string $sql, array $values = []): ?array",
        "    {",
        "        return self::all($db, $sql, $values)[0] ?? null;",
        "    }",
        "",
        "    /**",
        "     * Runs a statement with its values, in order.",
        "     *",
        "     * @param list<mixed> $values",
        "     */",
        "    public static function run(PDO $db, string $sql, array $values = []): PDOStatement",
        "    {",
        "        $statement = $db->prepare($sql);",
        "        foreach ($values as $index => $value) {",
        "            $statement->bindValue($index + 1, $value, match (true) {",
        "                $value === null => PDO::PARAM_NULL,",
        "                is_int($value) => PDO::PARAM_INT,",
        f"                is_bool($value) => PDO::{('PARAM_BOOL' if postgres else 'PARAM_INT')},",
        blobs and "                is_resource($value) => PDO::PARAM_LOB,",
        "                default => PDO::PARAM_STR,",
        "            });",
        "        }",
        "        $statement->execute();",
        "        return $statement;",
        "    }",
        "",
        "    /** Whether the database refused a write: a unique value taken, a row still pointed to, a value against its rules. */",
        "    public static function isRefusal(PDOException $error): bool",
        "    {",
        *(
            [
                "        // SQLSTATE class 23 (integrity constraint violation), or a CHECK of MySQL (3819) or MariaDB (4025)",
                "        return str_starts_with((string) $error->getCode(), '23') || in_array($error->errorInfo[1] ?? null, [3819, 4025], true);",
            ]
            if _is_mysql(context)
            else [
                "        // SQLSTATE class 23: integrity constraint violation",
                "        return str_starts_with((string) $error->getCode(), '23');",
            ]
        ),
        "    }",
        *(
            [
                "",
                "    /** The bytes of a binary column, which PDO gives as a stream. */",
                "    public static function bytes(mixed $value): string",
                "    {",
                "        return is_resource($value) ? (string) stream_get_contents($value) : (string) $value;",
                "    }",
            ]
            if postgres and _uses_kind(context, "binary")
            else []
        ),
        *(
            [
                "",
                "    /**",
                "     * Bytes as a stream, so SQLite keeps them as a BLOB and not as a text.",
                "     *",
                "     * @return resource",
                "     */",
                "    public static function blob(string $bytes)",
                "    {",
                "        $stream = fopen('php://memory', 'r+b');",
                "        fwrite($stream, $bytes);",
                "        rewind($stream);",
                "        return $stream;",
                "    }",
            ]
            if blobs
            else []
        ),
        *(
            [
                "",
                "    /** A list as an array literal of PostgreSQL. */",
                "    public static function arrayLiteral(array $items): string",
                "    {",
                "        return '{' . implode(',', array_map(fn (mixed $item) => match (true) {",
                "            $item === null => 'NULL',",
                "            is_array($item) => self::arrayLiteral($item),",
                "            is_bool($item) => $item ? 'true' : 'false',",
                "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
                "        }, $items)) . '}';",
                "    }",
            ]
            if postgres and _uses_kind(context, "array")
            else []
        ),
        "}",
    ]
    return php_file(
        path_of(context["base"], "Sql"),
        context["base"],
        "\n".join(["use PDO;", "use PDOException;", "use PDOStatement;"]),
        [line for line in body if isinstance(line, str)],
    )


def sql_entity_file(context: dict, info: dict) -> dict:
    """The entity of a table: a plain class with a property per column, null until it is set or read."""
    ns = namespace_of(context, info, "entity")
    properties = [
        line
        for index, column in enumerate(info["columns"])
        for line in [
            ("" if index > 0 else None),
            (f"    /** {column['column'].get('comment')} */" if column["column"].get("comment") else None),
            (
                f'    // TODO: "{column["column"]["type"]["sql"]}" has no PHP type here; it is kept as its text'
                if column["column"]["type"]["kind"] == "unknown"
                else None
            ),
            f"    public {optional_type(column)} ${column['prop']} = null;",
        ]
    ]
    return php_file(
        path_of(ns, info["entity"]),
        ns,
        "",
        [
            (
                f'/** A row of the "{info["name"]}" table'
                + (f": {info['table'].get('comment')}" if info["table"].get("comment") else "")
                + ". The repositories read and write it with SQL; a property stays null until it is set or read. */"
            ),
            f"class {info['entity']}",
            "{",
            *properties,
            "}",
        ],
    )


def sql_uses(context: dict, uses: PhpUses) -> None:
    """The uses of a repository that runs SQL."""
    uses.add("PDO", class_name(context["base"], "Sql"))


def sql_database_files(context: dict):
    return [_database_file(context), _sql_file(context)]
