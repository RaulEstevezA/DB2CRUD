"""The physical schema of a database that already exists (`db-schema`, docs/design.md). Mirrors
web/src/core/schema/types.ts.

A schema is a dictionary: {"format": "db-schema", "version": 1, "dialect", "source", "tables", "enums", "notes"}.
A table is {"name", "schema"?, "columns", "primaryKey" (a list, or None when there is none), "foreignKeys",
"uniques", "indexes", "checks", "entity"?, "comment"?, "origin"?}. A column type keeps the type as declared in
"sql" and what the rules understand of it in "kind" and its parameters.
"""

DB_SCHEMA_FORMAT = "db-schema"
DB_SCHEMA_VERSION = 1


def find_table(schema: dict, name: str, namespace: str | None = None) -> dict | None:
    """The table with this name (and namespace, when given)."""
    return next(
        (
            table
            for table in schema["tables"]
            if table["name"] == name and (namespace is None or table.get("schema") == namespace)
        ),
        None,
    )


def find_column(table: dict, name: str) -> dict | None:
    """The column with this name."""
    return next((column for column in table["columns"] if column["name"] == name), None)


def is_unique_key(table: dict, columns: list[str]) -> bool:
    """Whether these columns, in any order, are the primary key or a unique constraint of the table."""

    def same(other: list[str]) -> bool:
        return len(other) == len(columns) and all(column in columns for column in other)

    key = table["primaryKey"]
    return (key is not None and same(key)) or any(same(unique["columns"]) for unique in table["uniques"])
