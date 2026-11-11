"""Mirrors web/src/core/physical/relational/textKeys.ts."""

from .names import DEFAULT_LENGTH

# Engines that cannot use an unbounded text (TEXT, CLOB, NVARCHAR(MAX)) in a key, a unique constraint or an index
BOUNDED_KEYS = {"mysql", "mariadb", "sqlserver", "oracle"}


def bound_indexed_texts(build, tables: list[dict]) -> None:
    """Texts without a length that a key, a unique constraint, a foreign key or an index uses get one, where the
    engine needs it; a note says so."""
    if build.options["dialect"] not in BOUNDED_KEYS:
        return
    notes = []
    for table in tables:
        keyed = {
            *table["primaryKey"],
            *(column for unique in table["uniques"] for column in unique["columns"]),
            *(column for index in table["indexes"] for column in index["columns"]),
            *(column for fk in table["foreignKeys"] for column in fk["columns"]),
        }
        for column in table["columns"]:
            column_type = column["type"]
            if (
                column["name"] not in keyed
                or column_type["kind"] != "primitive"
                or column_type["name"] != "string"
                or column_type.get("length")
            ):
                continue
            column["type"] = {**column_type, "length": DEFAULT_LENGTH}
            notes.append(
                {
                    "code": "textKeyLength",
                    "params": {"column": f"{table['name']}.{column['name']}", "length": str(DEFAULT_LENGTH)},
                }
            )
    build.notes.extend(notes)
