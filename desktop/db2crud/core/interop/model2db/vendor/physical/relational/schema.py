"""Turns the active decisions of a design into tables, step by step. Pending decisions add a `todo` instead.
Mirrors web/src/core/physical/relational.ts."""

from ...design.types import find_model_design
from ..query_indexes import add_query_indexes
from ..roles import model_roles
from .build import DEFAULT_PRECISION, RelationalBuild
from .enums import build_enums, constrain_enum_columns
from .relations import add_relations
from .tables import add_entity_tables, add_keys, add_scalar_columns, add_scalar_foreign_keys
from .text_keys import bound_indexed_texts


def build_relational(schema: dict, design: dict, options: dict) -> dict:
    build = RelationalBuild(schema, design, options, model_roles(schema, design))
    add_entity_tables(build)
    key_fields = add_keys(build)
    add_scalar_columns(build, key_fields)
    add_scalar_foreign_keys(build)
    add_relations(build)
    _add_queries(build)
    enums, lookups = build_enums(build)
    tables = [*lookups, *(entity.table for entity in build.entities.values()), *build.extra_tables]
    constrain_enum_columns(tables, enums, lookups)
    bound_indexed_texts(build, tables)
    if build.decimals:
        build.notes.append(
            {
                "code": "defaultPrecision",
                "params": {
                    "fields": ", ".join(build.decimals),
                    "precision": f"{DEFAULT_PRECISION['precision']}, {DEFAULT_PRECISION['scale']}",
                },
            }
        )
    return {"kind": "relational", "tables": tables, "enums": enums, "notes": build.notes}


def _add_queries(build: RelationalBuild) -> None:
    """The index of each query the user accepted, on the model's table."""
    indexed = False
    for entity in build.entities.values():
        model = entity.model["name"]
        table = entity.table
        item = find_model_design(build.design, model)
        queries = (item or {}).get("queries") or []

        def column_of(field: str, model=model, table=table) -> str | None:
            own = next(
                (column["name"] for column in table["columns"] if column.get("source") == f"{model}.{field}"), None
            )
            if own:
                return own
            key = next(
                (fk for fk in table["foreignKeys"] if fk.get("field") == field and len(fk["columns"]) == 1), None
            )
            return key["columns"][0] if key else None

        added = add_query_indexes(
            {
                "name": table["name"],
                "model": model,
                "column_of": column_of,
                "indexes": table["indexes"],
                "covering": [{"name": "", "columns": table["primaryKey"], "unique": True}, *table["uniques"]],
                "pending": lambda query, model=model, table=table: build.todo(
                    table, "queryPending", {"model": model, "query": query}
                ),
            },
            queries,
            build.notes,
        )
        indexed = indexed or added
    if indexed:
        build.notes.append({"code": "queryIndexes", "params": {}})
