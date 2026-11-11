"""Turns the active decisions of a design into tables, step by step. Pending decisions add a `todo` instead.
Mirrors web/src/core/physical/relational.ts."""

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
