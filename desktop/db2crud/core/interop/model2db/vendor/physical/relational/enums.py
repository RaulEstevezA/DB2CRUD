"""Mirrors web/src/core/physical/relational/enums.ts."""

from ...js import coalesce, is_number
from ...model.naming import to_snake_case
from ...model.schema import find_enum
from ..naming import column_name, constraint_name, free_name, table_name
from .build import RelationalBuild
from .names import enum_length

# Databases without enum types of their own: a native enum becomes a CHECK there
NO_ENUM_TYPES = {"sqlite", "sqlserver", "oracle"}


def build_enums(build: RelationalBuild) -> tuple[list[dict], list[dict]]:
    """The enums the columns use, as the user chose to store them, and their lookup tables."""
    schema, design, options = build.schema, build.design, build.options
    enums: list[dict] = []
    lookups: list[dict] = []
    for name in build.enums_used:
        definition = find_enum(schema, name)
        if not definition:
            continue
        values = [coalesce(value.get("value"), value["name"]) for value in definition["values"]]
        item = next((entry for entry in design["enums"] if entry["enum"] == name), None)
        storage = coalesce(item["storage"]["value"] if item else None, "check")
        if storage == "native" and options["dialect"] in NO_ENUM_TYPES:
            build.notes.append({"code": "nativeEnumAsCheck", "params": {"enum": name}})
            storage = "check"
        sql_name = (
            free_name(table_name(name, options["naming"]), build.used_tables)
            if storage == "lookup"
            else to_snake_case(name)
        )
        enums.append({"name": name, "sqlName": sql_name, "values": values, "storage": storage})
        if storage == "lookup":
            numeric = all(is_number(value) for value in values)
            code = column_name("code", options["naming"])
            lookups.append(
                {
                    "name": sql_name,
                    "kind": "lookup",
                    "model": name,
                    "columns": [
                        {
                            "name": code,
                            "type": {"kind": "primitive", "name": "integer", "bits": 32}
                            if numeric
                            else {"kind": "primitive", "name": "string", "length": enum_length(values)},
                            "nullable": False,
                        }
                    ],
                    "primaryKey": [code],
                    "foreignKeys": [],
                    "uniques": [],
                    "indexes": [],
                    "checks": [],
                    "todos": [],
                }
            )
    return enums, lookups


def constrain_enum_columns(tables: list[dict], enums: list[dict], lookups: list[dict]) -> None:
    """The CHECK constraints and lookup foreign keys of every enum column."""
    for table in tables:
        for column in table["columns"]:
            if column["type"]["kind"] != "enum":
                continue
            physical = next((item for item in enums if item["name"] == column["type"]["name"]), None)
            if not physical:
                continue
            if physical["storage"] == "check":
                table["checks"].append(
                    {
                        "name": constraint_name("ck", table["name"], [column["name"]]),
                        "column": column["name"],
                        "values": physical["values"],
                    }
                )
            if physical["storage"] == "lookup":
                lookup = next(item for item in lookups if item["name"] == physical["sqlName"])
                table["foreignKeys"].append(
                    {
                        "name": constraint_name("fk", table["name"], [column["name"]]),
                        "columns": [column["name"]],
                        "table": lookup["name"],
                        "references": [lookup["primaryKey"][0]],
                    }
                )
