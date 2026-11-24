"""The DBAL types a Doctrine project adds for its timestamps. DBAL 4 reads a timestamp only in the exact format of the
platform, without fractions of a second, while a database that already exists usually keeps them: these types read any
precision and write microseconds. Mirrors web/src/core/generators/php/doctrine/types.ts."""

from ..common.context import path_of, php_file

PRECISE = "precise_datetime"
PRECISE_TZ = "precise_datetimetz"
PRECISE_TIME_TZ = "precise_timetz"
PG_ARRAY = "pg_array"

# The classes and DBAL names of the types, for Database.php
PRECISE_TYPES = [
    {"name": "PreciseDateTimeType", "id": PRECISE},
    {"name": "PreciseDateTimeTzType", "id": PRECISE_TZ},
]


def types_namespace(context: dict) -> str:
    return f"{context['base']}\\Types"


def uses_precise_types(context: dict) -> bool:
    """Whether an entity the project writes has a timestamp."""
    return any(
        info["writesEntity"] and any(column["column"]["type"]["kind"] == "datetime" for column in info["columns"])
        for info in context["tables"]
    )


def _type(ns: str, name: str, parent: str, type_id: str, doc: str, time_format: str) -> dict:
    return php_file(
        path_of(ns, name),
        ns,
        "\n".join(["use Doctrine\\DBAL\\Platforms\\AbstractPlatform;", f"use Doctrine\\DBAL\\Types\\{parent};"]),
        [
            f"/** {doc}, read whatever its fractions of a second and written with microseconds. */",
            f"final class {name} extends {parent}",
            "{",
            f"    public const NAME = '{type_id}';",
            "",
            "    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?\\DateTimeImmutable",
            "    {",
            "        if ($value === null || $value instanceof \\DateTimeImmutable) {",
            "            return $value;",
            "        }",
            "        return new \\DateTimeImmutable((string) $value);",
            "    }",
            "",
            "    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string",
            "    {",
            "        if ($value instanceof \\DateTimeInterface) {",
            f"            return $value->format('{time_format}');",
            "        }",
            "        return parent::convertToDatabaseValue($value, $platform);",
            "    }",
            "}",
        ],
    )


def uses_pg_array(context: dict) -> bool:
    """Whether an entity the project writes has an array of PostgreSQL."""
    return context["settings"]["database"] == "postgresql" and any(
        info["writesEntity"] and any(column["column"]["type"]["kind"] == "array" for column in info["columns"])
        for info in context["tables"]
    )


def uses_time_tz(context: dict) -> bool:
    """Whether an entity the project writes has a time with a time zone of PostgreSQL."""
    return context["settings"]["database"] == "postgresql" and any(
        column["column"]["type"]["kind"] == "time" and column["column"]["type"].get("timezone")
        for info in context["tables"]
        if info["writesEntity"]
        for column in info["columns"]
    )


def _pg_array_file(context: dict) -> dict:
    """The DBAL type of an array of PostgreSQL: read as JSON, written as its text."""
    ns = types_namespace(context)
    return php_file(
        path_of(ns, "PgArrayType"),
        ns,
        "use Doctrine\\DBAL\\Platforms\\AbstractPlatform;\nuse Doctrine\\DBAL\\Types\\JsonType;",
        [
            "/** An array of PostgreSQL as a PHP array: the database gives it as JSON, and takes it as its text ({a,b}). */",
            "final class PgArrayType extends JsonType",
            "{",
            "    public const NAME = 'pg_array';",
            "",
            "    public function convertToPHPValueSQL(string $sqlExpr, AbstractPlatform $platform): string",
            "    {",
            "        return 'to_json(' . $sqlExpr . ')';",
            "    }",
            "",
            "    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string",
            "    {",
            "        return is_array($value) ? self::write($value) : $value;",
            "    }",
            "",
            "    private static function write(array $items): string",
            "    {",
            "        $written = array_map(fn (mixed $item): string => match (true) {",
            "            $item === null => 'NULL',",
            "            is_array($item) => self::write($item),",
            "            is_bool($item) => $item ? 't' : 'f',",
            "            default => '\"' . addcslashes((string) $item, '\"\\\\') . '\"',",
            "        }, $items);",
            "        return '{' . implode(',', $written) . '}';",
            "    }",
            "}",
        ],
    )


def _time_tz_file(context: dict) -> dict:
    """The DBAL type of a time with a time zone, which DBAL's own cannot read."""
    ns = types_namespace(context)
    return php_file(
        path_of(ns, "PreciseTimeTzType"),
        ns,
        "use Doctrine\\DBAL\\Platforms\\AbstractPlatform;\nuse Doctrine\\DBAL\\Types\\TimeImmutableType;",
        [
            "/** A time with a time zone, read and written with its offset. */",
            "final class PreciseTimeTzType extends TimeImmutableType",
            "{",
            "    public const NAME = 'precise_timetz';",
            "",
            "    public function convertToPHPValue(mixed $value, AbstractPlatform $platform): ?\\DateTimeImmutable",
            "    {",
            "        if ($value === null || $value instanceof \\DateTimeImmutable) {",
            "            return $value;",
            "        }",
            "        return new \\DateTimeImmutable((string) $value);",
            "    }",
            "",
            "    public function convertToDatabaseValue(mixed $value, AbstractPlatform $platform): ?string",
            "    {",
            "        return $value instanceof \\DateTimeInterface ? $value->format('H:i:s.uP') : parent::convertToDatabaseValue($value, $platform);",
            "    }",
            "}",
        ],
    )


def type_files(context: dict) -> list[dict]:
    arrays = [_pg_array_file(context)] if uses_pg_array(context) else []
    if uses_time_tz(context):
        arrays.append(_time_tz_file(context))
    if not uses_precise_types(context):
        return arrays
    ns = types_namespace(context)
    # Only PostgreSQL keeps the offset: MySQL and MariaDB refuse it in a datetime, and SQLite keeps text
    tz_format = "Y-m-d H:i:s.uP" if context["settings"]["database"] == "postgresql" else "Y-m-d H:i:s.u"
    return [
        *arrays,
        _type(
            ns,
            "PreciseDateTimeType",
            "DateTimeImmutableType",
            PRECISE,
            "A timestamp without a time zone",
            "Y-m-d H:i:s.u",
        ),
        _type(
            ns,
            "PreciseDateTimeTzType",
            "DateTimeTzImmutableType",
            PRECISE_TZ,
            "A timestamp with a time zone",
            tz_format,
        ),
    ]
