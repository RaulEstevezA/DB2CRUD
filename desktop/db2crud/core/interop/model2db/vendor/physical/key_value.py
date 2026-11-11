"""Turns the active decisions of a design into Redis keys: a hash for each stored model under `prefix:<key>`,
with lists, sets and hashes of its own under that key, and a search index on the fields other keys point to
and the ones the user indexed. Redis keeps every value as text; the description says what each one holds.
Mirrors web/src/core/physical/keyValue.ts."""

from ..design.types import find_model_design
from ..js import coalesce
from ..model.schema import all_fields, find_enum, find_model, model_of
from .document import key_holder
from .naming import column_name, free_name, join_names, table_name
from .relational.names import stores_null
from .roles import model_roles


def _holds_of(type_ref: dict) -> str:
    if type_ref["kind"] != "primitive":
        return "text" if type_ref["kind"] == "enum" else "json"
    name = type_ref["name"]
    if name in ("integer", "float", "decimal"):
        return "number"
    if name == "boolean":
        return "boolean"
    if name in ("date", "datetime"):
        return "date"
    if name == "any":
        return "json"
    return "text"


def build_key_value(schema: dict, design: dict, naming: dict) -> dict:
    roles = model_roles(schema, design)
    notes: list[dict] = []
    used: set[str] = set()
    prefixes: dict[str, str] = {}
    for model in schema["models"]:
        item = find_model_design(design, model["name"])
        # A model the design does not have yet (the model changed and the design follows a moment later) is left out
        if roles.get(model["name"]) != "stored" or not item:
            continue
        prefixes[model["name"]] = free_name(
            coalesce((item or {}).get("table"), table_name(model["name"], naming)), used
        )

    def build_entry(model: dict) -> dict:
        prefix = prefixes[model["name"]]
        item = find_model_design(design, model["name"])
        entry = {
            "model": model["name"],
            "prefix": prefix,
            "keyField": None,
            "newKey": None,
            "fields": [],
            "structures": [],
            "search": [],
            "todos": [],
        }
        key = item.get("key")
        if not key or key["status"] == "pending":
            entry["todos"].append({"code": "keyPending", "params": {"model": model["name"]}})
        elif key["value"]["kind"] == "surrogate":
            entry["newKey"] = "uuid" if key["value"]["type"] == "uuid" else "counter"
        field_names: set[str] = set()

        def search(field: str, search_type: str) -> None:
            if not any(other["field"] == field for other in entry["search"]):
                entry["search"].append({"field": field, "type": search_type})

        fields = all_fields(schema, model)
        # `customer` next to `customerId`: the key goes in that field, which points to the customer
        holders: dict[str, str] = {}
        for field in fields:
            decided = next((other for other in item["fields"] if other["field"] == field["name"]), None)
            target = model_of(field["type"])
            relation = (decided or {}).get("relation")
            if (decided or {}).get("include") is False or not relation or relation["status"] != "active":
                continue
            if relation["value"] != "reference" or not target:
                continue
            holder = key_holder(field, fields, item, {"naming": naming})
            refers = prefixes.get(target)
            if holder and refers:
                holders[holder] = refers

        def add_fields(owner: list[dict], decisions: list[dict], path: list[str], source: str) -> None:
            for field in owner:
                decided = next((other for other in decisions if other["field"] == field["name"]), None)
                if decided and not decided["include"]:
                    continue
                if path:
                    wanted = join_names([*path, field["name"]], naming)
                else:
                    wanted = coalesce(
                        (decided or {}).get("column"), field.get("serializedName"), column_name(field["name"], naming)
                    )
                name = free_name(wanted, field_names)
                field_source = f"{source}.{field['name']}"
                relation = (decided or {}).get("relation")
                if relation and relation["status"] == "pending":
                    entry["todos"].append(
                        {"code": "relationPending", "params": {"field": ".".join([*path, field["name"]])}}
                    )
                    continue
                target = model_of(field["type"])
                if relation and target and find_model(schema, target) and relation["value"] in ("reference", "child"):
                    refers = prefixes.get(target)
                    if not refers:
                        entry["todos"].append(
                            {"code": "targetNotStored", "params": {"field": field["name"], "model": target}}
                        )
                        continue
                    if relation["value"] == "child":
                        entry["structures"].append(
                            {"suffix": name, "type": "set", "holds": "key", "refers": refers, "source": field_source}
                        )
                        continue
                    if not path and key_holder(field, owner, item, {"naming": naming}):
                        continue
                    key_name = free_name(join_names([*path, field["name"], "id"], naming), field_names)
                    field_names.discard(name.lower())
                    entry["fields"].append(
                        {
                            "name": key_name,
                            "holds": "key",
                            "refers": refers,
                            "nullable": stores_null(field),
                            "source": field_source,
                        }
                    )
                    search(key_name, "TAG")
                    continue
                if relation and relation["value"] == "flatten" and target:
                    field_names.discard(name.lower())
                    inner = find_model(schema, target)
                    inner_decisions = (find_model_design(design, target) or {}).get("fields") or []
                    add_fields(all_fields(schema, inner), inner_decisions, [*path, field["name"]], field_source)
                    continue
                type_ref = field["type"]
                if relation and relation["value"] == "child":
                    if type_ref["kind"] == "array":
                        items = type_ref["items"]
                    elif type_ref["kind"] == "map":
                        items = type_ref["value"]
                    else:
                        items = type_ref
                    entry["structures"].append(
                        {
                            "suffix": name,
                            "type": "hash" if type_ref["kind"] == "map" else "list",
                            "holds": _holds_of(items),
                            "source": field_source,
                        }
                    )
                    continue
                hash_field = {
                    "name": name,
                    "holds": "json" if relation else _holds_of(type_ref),
                    "nullable": stores_null(field),
                    "source": field_source,
                }
                if type_ref["kind"] == "enum":
                    found = find_enum(schema, type_ref["name"])
                    if found:
                        hash_field["values"] = [
                            value["value"] if value.get("value") is not None else value["name"]
                            for value in found["values"]
                        ]
                    search(name, "TAG")
                foreign_key = (decided or {}).get("foreignKey")
                held = holders.get(name) if not path else None
                if held:
                    hash_field["holds"] = "key"
                    hash_field["refers"] = held
                    search(name, "TAG")
                elif foreign_key and foreign_key["status"] == "active" and foreign_key["value"]:
                    refers = prefixes.get(foreign_key["value"])
                    if refers:
                        hash_field["holds"] = "key"
                        hash_field["refers"] = refers
                        search(name, "TAG")
                    else:
                        entry["todos"].append(
                            {
                                "code": "targetNotStored",
                                "params": {"field": field["name"], "model": foreign_key["value"]},
                            }
                        )
                is_key = (
                    not path
                    and key
                    and key["status"] == "active"
                    and key["value"]["kind"] == "field"
                    and key["value"]["field"] == field["name"]
                )
                if is_key:
                    entry["keyField"] = name
                    hash_field["nullable"] = False
                else:
                    unique = bool(
                        decided and decided.get("unique") and decided["unique"]["status"] == "active"
                    ) and bool(decided["unique"]["value"])
                    if unique:
                        notes.append(
                            {
                                "code": "uniqueInApplication",
                                "params": {"database": "Redis", "field": f"{model['name']}.{field['name']}"},
                            }
                        )
                    if unique or (decided or {}).get("index"):
                        search(name, "NUMERIC" if hash_field["holds"] == "number" else "TAG")
                entry["fields"].append(hash_field)

        add_fields(fields, item["fields"], [], model["name"])
        return entry

    entries = [build_entry(model) for model in schema["models"] if model["name"] in prefixes]
    return {"kind": "keyvalue", "entries": entries, "notes": notes}
