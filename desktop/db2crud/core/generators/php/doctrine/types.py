"""The DBAL types a Doctrine project adds for its timestamps. DBAL 4 reads a timestamp only in the exact format of the
platform, without fractions of a second, while a database that already exists usually keeps them: these types read any
precision and write microseconds. Mirrors web/src/core/generators/php/doctrine/types.ts."""

from ..common.context import path_of, php_file

PRECISE = "precise_datetime"
PRECISE_TZ = "precise_datetimetz"

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


def type_files(context: dict) -> list[dict]:
    if not uses_precise_types(context):
        return []
    ns = types_namespace(context)
    # Only PostgreSQL keeps the offset: MySQL and MariaDB refuse it in a datetime, and SQLite keeps text
    tz_format = "Y-m-d H:i:s.uP" if context["settings"]["database"] == "postgresql" else "Y-m-d H:i:s.u"
    return [
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
