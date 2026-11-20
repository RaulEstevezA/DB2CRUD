"""Types written in SQL inside ORM code (a Drizzle `customType`, a JPA `columnDefinition`), as the rules understand
them. SQLite keeps every integer in 64 bits and every real number in double precision. Mirrors
web/src/core/importers/orm/sqlTypes.ts."""

import re

_SQL_TYPE = re.compile(r"([a-z ]+?)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?", re.IGNORECASE)


def sql_type_of(text: str, dialect: str | None) -> dict | None:
    """The database type of a type written in SQL (`datetime`, `varchar(20)`, `numeric(10, 2)`), or None when the
    rules do not know it."""
    sql = text.strip()
    match = _SQL_TYPE.fullmatch(sql)
    if not match:
        return None
    name = match.group(1).lower()
    size = int(match.group(2)) if match.group(2) is not None else None
    scale = int(match.group(3)) if match.group(3) is not None else None
    if name in ("smallint", "int2", "tinyint"):
        return {"sql": sql, "kind": "integer", "bits": 16}
    if name in ("int", "integer", "int4", "mediumint"):
        return {"sql": sql, "kind": "integer", "bits": 64 if dialect == "sqlite" else 32}
    if name in ("bigint", "int8"):
        return {"sql": sql, "kind": "integer", "bits": 64}
    if name in ("real", "float4", "float"):
        return {"sql": sql, "kind": "float", "bits": 64 if dialect == "sqlite" else 32}
    if name in ("double", "double precision", "float8"):
        return {"sql": sql, "kind": "float", "bits": 64}
    if name in ("decimal", "numeric"):
        return {
            "sql": sql,
            "kind": "decimal",
            **({"precision": size} if size is not None else {}),
            **({"scale": scale} if scale is not None else {}),
        }
    if name in ("varchar", "character varying", "nvarchar"):
        return {"sql": sql, "kind": "text", "length": size} if size is not None else {"sql": sql, "kind": "text"}
    if name in ("char", "character", "nchar"):
        if size is not None:
            return {"sql": sql, "kind": "text", "length": size, "fixed": True}
        return {"sql": sql, "kind": "text", "fixed": True}
    if name in ("text", "tinytext", "mediumtext", "longtext", "citext", "clob"):
        return {"sql": sql, "kind": "text"}
    if name in ("boolean", "bool"):
        return {"sql": sql, "kind": "boolean"}
    if name == "date":
        return {"sql": sql, "kind": "date"}
    if name in ("time", "time without time zone"):
        return {"sql": sql, "kind": "time", "timezone": False}
    if name in ("timetz", "time with time zone"):
        return {"sql": sql, "kind": "time", "timezone": True}
    if name in ("datetime", "timestamp", "timestamp without time zone"):
        return {"sql": sql, "kind": "datetime", "timezone": False}
    if name in ("timestamptz", "timestamp with time zone"):
        return {"sql": sql, "kind": "datetime", "timezone": True}
    if name in ("uuid", "uniqueidentifier"):
        return {"sql": sql, "kind": "uuid"}
    if name in ("json", "jsonb"):
        return {"sql": sql, "kind": "json"}
    if name in ("bytea", "blob", "binary", "varbinary", "longblob"):
        return {"sql": sql, "kind": "binary", "length": size} if size is not None else {"sql": sql, "kind": "binary"}
    return None
