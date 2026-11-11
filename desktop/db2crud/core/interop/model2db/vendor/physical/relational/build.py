"""The state shared by the steps of the relational build. Mirrors web/src/core/physical/relational/build.ts."""

from ...design.hints import declared_length, declared_precision
from ...model.schema import all_fields
from ..naming import constraint_name, free_name
from .names import DEFAULT_LENGTH

# Precision used for decimals whose input does not say it: enough for money in most currencies
DEFAULT_PRECISION = {"precision": 18, "scale": 2}


class Entity:
    """A stored model and its table while it is being built."""

    def __init__(self, model: dict, table: dict, design: list[dict]):
        self.model = model
        self.table = table
        self.design = design
        # Column names already used in the table, in lower case
        self.used: set[str] = set()
        # The primary key, once known: its column and type
        self.key: dict | None = None


class RelationalBuild:
    """The state shared by the steps of the relational build (tables, columns, relations, enums), with the
    operations every step uses: creating tables, typing columns, adding foreign keys and TODOs."""

    def __init__(self, schema: dict, design: dict, options: dict, roles: dict[str, str]):
        self.schema = schema
        self.design = design
        self.options = options
        self.roles = roles
        self.notes: list[dict] = []
        self.entities: dict[str, Entity] = {}
        # List, map and join tables, after the entities
        self.extra_tables: list[dict] = []
        # In the order they are first used, as a JavaScript Set keeps them
        self.enums_used: dict[str, None] = {}
        self.used_tables: set[str] = set()
        # Decimal fields that got the default precision
        self.decimals: list[str] = []

    def new_table(self, name: str, kind: str, model: str, field: str | None = None) -> dict:
        table = {"name": free_name(name, self.used_tables), "kind": kind, "model": model}
        if field:
            table["field"] = field
        table.update(
            {
                "columns": [],
                "primaryKey": [],
                "foreignKeys": [],
                "uniques": [],
                "indexes": [],
                "checks": [],
                "todos": [],
            }
        )
        return table

    def todo(self, table: dict, code: str, params: dict) -> None:
        table["todos"].append({"code": code, "params": params})

    def fields_of(self, entity: Entity) -> list[tuple[dict, dict | None]]:
        """Fields of a stored model with their decisions, inherited ones included."""
        return [
            (field, next((item for item in entity.design if item["field"] == field["name"]), None))
            for field in all_fields(self.schema, entity.model)
        ]

    def type_of(self, field: dict, decided: dict | None, path: str) -> dict:
        """The type of a field's column: the one the user wrote, or the one derived from the field."""
        if decided and decided.get("type"):
            return {"kind": "raw", "sql": decided["type"]}
        whole = (decided or {}).get("wholeNumber")
        type_ref = field["type"]
        if whole and whole["status"] == "active" and whole["value"] and type_ref["kind"] == "primitive":
            if type_ref["name"] == "float":
                return {"kind": "primitive", "name": "integer"}
        return self.column_type(field["type"], field, path)

    def column_type(self, type_ref: dict, field: dict, path: str) -> dict:
        if type_ref["kind"] == "enum":
            self.enums_used[type_ref["name"]] = None
            return {"kind": "enum", "name": type_ref["name"]}
        if type_ref["kind"] != "primitive" or type_ref["name"] == "any":
            return {"kind": "json"}
        result = {"kind": "primitive", "name": type_ref["name"]}
        if type_ref.get("bits"):
            result["bits"] = type_ref["bits"]
        strings, dialect = self.options["strings"], self.options["dialect"]
        if type_ref["name"] == "string":
            varchar = strings == "varchar" or (strings == "auto" and dialect not in ("postgresql", "sqlite"))
            length = declared_length(field)
            if length is None:
                length = DEFAULT_LENGTH if varchar else None
            if length:
                result["length"] = length
        if type_ref["name"] == "decimal":
            declared = declared_precision(field)
            if not declared:
                self.decimals.append(path)
            result.update(declared or DEFAULT_PRECISION)
        return result

    def foreign_key(
        self, table: dict, column: str, target: Entity, on_delete: str | None = None, navigation: dict | None = None
    ) -> None:
        """A foreign key from a column to a stored model's key, indexed; merges navigation into an existing one.
        Navigation keys whose value is None are left out, as undefined is in JSON."""
        navigation = {key: value for key, value in (navigation or {}).items() if value is not None}
        if not target.key:
            self.todo(table, "foreignKeyTargetNotStored", {"column": column, "model": target.model["name"]})
            return
        existing = next(
            (fk for fk in table["foreignKeys"] if len(fk["columns"]) == 1 and fk["columns"][0] == column), None
        )
        if existing:
            existing.update(navigation)
            return
        fk = {
            "name": constraint_name("fk", table["name"], [column]),
            "columns": [column],
            "table": target.table["name"],
            "references": [target.key["column"]],
        }
        if on_delete:
            fk["onDelete"] = on_delete
        fk.update(navigation)
        table["foreignKeys"].append(fk)
        if column not in table["primaryKey"] and not any(index["columns"][0] == column for index in table["indexes"]):
            table["indexes"].append(
                {"name": constraint_name("ix", table["name"], [column]), "columns": [column], "unique": False}
            )
