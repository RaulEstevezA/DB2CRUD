"""The tables of the stored models, their keys and their scalar columns. Mirrors
web/src/core/physical/relational/tables.ts."""

from ...design.hints import declares_uuid_default
from ...design.types import find_model_design
from ...model.schema import all_fields
from ..naming import column_name, constraint_name, free_name, table_name
from .build import Entity, RelationalBuild
from .names import field_column, key_type, stores_null


def add_entity_tables(build: RelationalBuild) -> None:
    schema, design, options, roles = build.schema, build.design, build.options, build.roles
    for model in schema["models"]:
        if roles.get(model["name"]) != "stored":
            continue
        item = find_model_design(design, model["name"])
        if not item:
            continue
        table = build.new_table(
            item.get("table") or table_name(model["name"], options["naming"]), "entity", model["name"]
        )
        entity = Entity(model, table, item["fields"])
        build.entities[model["name"]] = entity
        # Field columns keep their names; a surrogate key takes a free one
        for field, decided in build.fields_of(entity):
            if decided and decided["include"] and not decided.get("relation"):
                entity.used.add(field_column(field, decided, options).lower())
        parents = [parent for parent in model.get("extends") or [] if roles.get(parent) == "parent"]
        if parents:
            build.notes.append(
                {"code": "inheritedFields", "params": {"model": model["name"], "parents": ", ".join(parents)}}
            )


def add_keys(build: RelationalBuild) -> dict[str, str]:
    """New key columns, and the key of every table whose key is one of its fields. Keys go first, so the
    columns that refer to them can take their type. Returns the key field of each model."""
    key_fields: dict[str, str] = {}
    for entity in build.entities.values():
        decision = (find_model_design(build.design, entity.model["name"]) or {}).get("key")
        if not decision or decision["status"] == "pending":
            build.todo(entity.table, "keyPending", {"model": entity.model["name"]})
            continue
        key = decision["value"]
        if key["kind"] == "surrogate":
            name = free_name(column_name("id", build.options["naming"]), entity.used)
            column_type = (
                {"kind": "primitive", "name": "uuid"}
                if key["type"] == "uuid"
                else {"kind": "primitive", "name": "integer", "bits": 64}
            )
            entity.table["columns"].append(
                {
                    "name": name,
                    "type": column_type,
                    "nullable": False,
                    "generated": "uuid" if key["type"] == "uuid" else "identity",
                }
            )
            entity.table["primaryKey"] = [name]
            entity.key = {"column": name, "type": column_type}
    for entity in build.entities.values():
        decision = (find_model_design(build.design, entity.model["name"]) or {}).get("key")
        if not decision or decision["status"] != "active" or decision["value"]["kind"] != "field":
            continue
        name = decision["value"]["field"]
        field = next((item for item in all_fields(build.schema, entity.model) if item["name"] == name), None)
        if not field:
            continue
        decided = next((item for item in entity.design if item["field"] == name), None)
        key_fields[entity.model["name"]] = name
        entity.key = {
            "column": field_column(field, decided, build.options),
            "type": key_type(build.type_of(field, decided, f"{entity.model['name']}.{name}")),
        }
    return key_fields


def add_scalar_columns(build: RelationalBuild, key_fields: dict[str, str]) -> None:
    """One column per scalar field, with its key, unique and index settings."""
    for entity in build.entities.values():
        table, model = entity.table, entity.model
        key_field = key_fields.get(model["name"])
        for field, decided in build.fields_of(entity):
            if not decided or not decided["include"] or decided.get("relation"):
                continue
            name = field_column(field, decided, build.options)
            is_key = field["name"] == key_field
            # A column holding another table's key has that key's type
            foreign = decided.get("foreignKey")
            fk = (
                build.entities.get(foreign["value"])
                if foreign and foreign["status"] == "active" and foreign["value"]
                else None
            )
            if is_key and entity.key:
                column_type = entity.key["type"]
            elif fk and fk.key and not decided.get("type"):
                column_type = fk.key["type"]
            else:
                column_type = build.type_of(field, decided, f"{model['name']}.{field['name']}")
            column = {
                "name": name,
                "type": column_type,
                "nullable": False if is_key else stores_null(field),
                "source": f"{model['name']}.{field['name']}",
            }
            if "defaultValue" in field and not is_key:
                column["defaultValue"] = field["defaultValue"]
            if field.get("generated") and column_type["kind"] == "primitive":
                if is_key and column_type["name"] == "integer":
                    column["generated"] = "identity"
                if is_key and column_type["name"] == "uuid":
                    column["generated"] = "uuid"
                if column_type["name"] == "string" and declares_uuid_default(field):
                    column["generated"] = "uuid"
                if not is_key and column_type["name"] in ("datetime", "date"):
                    column["generated"] = "now"
            table["columns"].append(column)
            if is_key:
                table["primaryKey"] = [name]
            unique = decided.get("unique")
            if unique and unique["status"] == "active" and unique["value"] and not is_key:
                table["uniques"].append(
                    {"name": constraint_name("uq", table["name"], [name]), "columns": [name], "unique": True}
                )
            if decided.get("index") and not is_key:
                table["indexes"].append(
                    {"name": constraint_name("ix", table["name"], [name]), "columns": [name], "unique": False}
                )


def add_scalar_foreign_keys(build: RelationalBuild) -> None:
    """Scalar fields that hold another model's key (`customerId` → customers)."""
    for entity in build.entities.values():
        for field, decided in build.fields_of(entity):
            fk = decided.get("foreignKey") if decided else None
            if not decided or not decided["include"] or not fk or fk["status"] != "active" or fk["value"] is None:
                continue
            target = build.entities.get(fk["value"])
            column = field_column(field, decided, build.options)
            if target:
                build.foreign_key(entity.table, column, target)
            else:
                build.todo(entity.table, "targetNotStored", {"field": field["name"], "model": fk["value"]})
