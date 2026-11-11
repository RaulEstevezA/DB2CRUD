"""Turns the active decisions of a design into Cassandra and ScyllaDB tables: one per stored model, partitioned by
its key; values kept in the row as user-defined types or collections; and, for a list of other models, a table
partitioned by the owner's key. Mirrors web/src/core/physical/wideColumn.ts."""

from ..design.types import find_model_design
from ..js import coalesce
from ..model.naming import to_snake_case
from ..model.schema import all_fields, find_model, model_of
from .document import key_holder
from .naming import column_name, constraint_name, free_name, join_names, table_name
from .relational.names import key_column_name, owned_table_name
from .roles import model_roles

_INTEGERS = {64: "bigint", 8: "tinyint", 16: "smallint"}
_SCALARS = {
    "decimal": "decimal",
    "boolean": "boolean",
    "date": "date",
    "datetime": "timestamp",
    "time": "time",
    "duration": "duration",
    "uuid": "uuid",
    "binary": "blob",
}


def scalar_type(type_ref: dict, key: bool = False) -> str:
    """The CQL type of a scalar. A number without a size used as a key is a whole number."""
    if type_ref["kind"] != "primitive":
        return "text"
    name = type_ref["name"]
    bits = type_ref.get("bits")
    if name == "integer":
        return _INTEGERS.get(bits, "int")
    if name == "float":
        if key and bits is None:
            return "bigint"
        return "float" if bits == 32 else "double"
    return _SCALARS.get(name, "text")


def build_wide_column(schema: dict, design: dict, naming: dict, database: str) -> dict:
    """`database` names the engine in the notes."""
    roles = model_roles(schema, design)
    notes: list[dict] = []
    table_names: set[str] = set()
    type_names: set[str] = set()
    tables: list[dict] = []
    types: list[dict] = []
    udts: dict[str, str] = {}
    entities: dict[str, dict] = {}

    for model in schema["models"]:
        item = find_model_design(design, model["name"])
        # A model the design does not have yet (the model changed and the design follows a moment later) is left out
        if roles.get(model["name"]) != "stored" or not item:
            continue
        table = {
            "name": free_name(coalesce((item or {}).get("table"), table_name(model["name"], naming)), table_names),
            "model": model["name"],
            "kind": "entity",
            "columns": [],
            "partitionKey": [],
            "clusteringKey": [],
            "indexes": [],
            "todos": [],
        }
        entities[model["name"]] = table
        tables.append(table)

    def key_of(model: str) -> dict | None:
        """The key column of a stored model, as other rows hold it: its name and type."""
        item = find_model_design(design, model) or {}
        key = item.get("key")
        if not key or key["status"] != "active":
            return None
        if key["value"]["kind"] == "surrogate":
            return {"column": "id", "type": "uuid"}
        name = key["value"]["field"]
        found = find_model(schema, model)
        field = next((other for other in all_fields(schema, found) if other["name"] == name), None) if found else None
        if not field:
            return None
        decided = next((other for other in item.get("fields", []) if other["field"] == name), None)
        column = coalesce((decided or {}).get("column"), field.get("serializedName"), column_name(name, naming))
        return {"column": column, "type": scalar_type(field["type"], True)}

    def columns_of(
        owner: list[dict], decisions: list[dict], path: list[str], source: str, used: set, todos: list, table
    ) -> list[dict]:
        """The columns (or type fields) of some fields, with what they need: user-defined types, key columns,
        tables."""
        columns: list[dict] = []

        def add(name: str, column_type: str, field_source: str) -> None:
            columns.append({"name": free_name(name, used), "type": column_type, "source": field_source})

        for field in owner:
            decided = next((other for other in decisions if other["field"] == field["name"]), None)
            if decided and not decided["include"]:
                continue
            field_source = f"{source}.{field['name']}"
            relation = (decided or {}).get("relation")
            if relation and relation["status"] == "pending":
                todos.append({"code": "relationPending", "params": {"field": ".".join([*path, field["name"]])}})
                continue
            if path:
                wanted = join_names([*path, field["name"]], naming)
            else:
                wanted = coalesce(
                    (decided or {}).get("column"), field.get("serializedName"), column_name(field["name"], naming)
                )
            target = model_of(field["type"])
            type_ref = field["type"]
            if relation and target and find_model(schema, target):
                value = relation["value"]
                if value in ("reference", "child"):
                    key = key_of(target) if target in entities else None
                    if not key:
                        todos.append({"code": "targetNotStored", "params": {"field": field["name"], "model": target}})
                        continue
                    if value == "child" and table and not path:
                        child_table(table, field, target, key)
                        continue
                    if value == "child":
                        add(wanted, f"list<{key['type']}>", field_source)
                        continue
                    # `author` next to `authorId`: the key is already in that column
                    if not path and table:
                        owner_design = find_model_design(design, table["model"])
                        if key_holder(field, owner, owner_design, {"naming": naming}):
                            continue
                    add(join_names([*path, field["name"], key["column"]], naming), key["type"], field_source)
                    continue
                if value == "embed":
                    udt = type_of(target)
                    add(
                        wanted,
                        f"list<frozen<{udt}>>" if type_ref["kind"] == "array" else f"frozen<{udt}>",
                        field_source,
                    )
                    continue
                if value == "flatten":
                    inner = find_model(schema, target)
                    inner_decisions = (find_model_design(design, target) or {}).get("fields") or []
                    columns.extend(
                        columns_of(
                            all_fields(schema, inner),
                            inner_decisions,
                            [*path, field["name"]],
                            field_source,
                            used,
                            todos,
                            None,
                        )
                    )
                    continue
            if relation and relation["value"] == "array":
                if type_ref["kind"] == "array":
                    add(wanted, f"list<{scalar_type(type_ref['items'])}>", field_source)
                elif type_ref["kind"] == "map":
                    key_type, value_type = scalar_type(type_ref["key"]), scalar_type(type_ref["value"])
                    add(wanted, f"map<{key_type}, {value_type}>", field_source)
                continue
            # JSON, free values and plain fields
            add(wanted, "text" if relation else scalar_type(type_ref), field_source)
            if table and not path and not relation:
                unique = bool(decided and decided.get("unique") and decided["unique"]["status"] == "active") and bool(
                    decided["unique"]["value"]
                )
                if unique:
                    notes.append(
                        {"code": "uniqueInApplication", "params": {"database": database, "field": field_source}}
                    )
                column = columns[-1]["name"]
                if (unique or (decided or {}).get("index")) and column not in table["partitionKey"]:
                    table["indexes"].append({"name": constraint_name("ix", table["name"], [column]), "column": column})
        return columns

    def type_of(model: str) -> str:
        """The user-defined type of a model kept inside rows; made once, after the types it uses."""
        if model in udts:
            return udts[model]
        name = free_name(to_snake_case(model), type_names)
        udts[model] = name
        found = find_model(schema, model)
        decisions = (find_model_design(design, model) or {}).get("fields") or []
        fields = columns_of(all_fields(schema, found), decisions, [], model, set(), [], None)
        types.append({"name": name, "fields": [{"name": field["name"], "type": field["type"]} for field in fields]})
        return name

    def child_table(owner: dict, field: dict, target: str, key: dict) -> None:
        """`User.posts`: a table partitioned by the user's key, with the key of each post."""
        owner_key = key_of(owner["model"])
        if not owner_key:
            return
        used: set[str] = set()
        owner_column = free_name(key_column_name(owner["model"], owner_key["column"], {"naming": naming}), used)
        target_column = free_name(key_column_name(target, key["column"], {"naming": naming}), used)
        source = f"{owner['model']}.{field['name']}"
        tables.append(
            {
                "name": free_name(owned_table_name(owner["model"], field["name"], {"naming": naming}), table_names),
                "model": owner["model"],
                "kind": "child",
                "columns": [
                    {"name": owner_column, "type": owner_key["type"], "source": source},
                    {"name": target_column, "type": key["type"], "source": source},
                ],
                "partitionKey": [owner_column],
                "clusteringKey": [target_column],
                "indexes": [],
                "todos": [],
            }
        )

    for model_name, table in entities.items():
        model = find_model(schema, model_name)
        item = find_model_design(design, model_name)
        used: set[str] = set()
        key = item.get("key")
        if not key or key["status"] == "pending":
            table["todos"].append({"code": "keyPending", "params": {"model": model_name}})
        elif key["value"]["kind"] == "surrogate":
            name = free_name("id", used)
            table["columns"].append({"name": name, "type": "uuid"})
            table["partitionKey"] = [name]
        else:
            key_field = key_of(model_name)
            if key_field:
                table["partitionKey"] = [key_field["column"]]
        columns = columns_of(all_fields(schema, model), item["fields"], [], model_name, used, table["todos"], table)
        # The key column takes the key's type: a number without a size is a whole number there
        key_field = (
            key_of(model_name) if key and key["status"] == "active" and key["value"]["kind"] == "field" else None
        )
        for column in columns:
            if key_field and column["name"] == key_field["column"]:
                column["type"] = key_field["type"]
        table["columns"].extend(columns)
    return {"kind": "widecolumn", "types": types, "tables": tables, "notes": notes}
