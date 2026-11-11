"""Edits of a design. Each returns a new design and leaves the previous one untouched, so the history can
keep it for undo. Mirrors web/src/core/design/edit.ts."""

from .propose import propose_design
from .types import FIELD_DECISIONS, same_value


def _map_model(design: dict, model: str, change) -> dict:
    return {**design, "models": [change(item) if item["model"] == model else item for item in design["models"]]}


def _map_field(design: dict, model: str, field: str, change) -> dict:
    def update(item: dict) -> dict:
        return {**item, "fields": [change(entry) if entry["field"] == field else entry for entry in item["fields"]]}

    return _map_model(design, model, update)


def _choose(decision: dict, value) -> dict:
    return {**decision, "value": value, "status": "active", "manual": True}


def get_decision(design: dict, ref: dict) -> dict | None:
    if ref["kind"] == "enum":
        item = next((entry for entry in design["enums"] if entry["enum"] == ref["enum"]), None)
        return item["storage"] if item else None
    model = next((entry for entry in design["models"] if entry["model"] == ref["model"]), None)
    if ref["kind"] == "key":
        return model.get("key") if model else None
    field = next((entry for entry in model["fields"] if entry["field"] == ref["field"]), None) if model else None
    return field.get(ref["kind"]) if field else None


_MISSING = object()


def decide(design: dict, ref: dict, value=_MISSING) -> dict:
    """Chooses a value for a decision; without a value, confirms the suggestion as it is."""
    current = get_decision(design, ref)
    if not current:
        return design
    chosen = current["value"] if value is _MISSING else value
    if not any(same_value(option, chosen) for option in current["options"]):
        return design
    if ref["kind"] == "enum":
        return {
            **design,
            "enums": [
                {**item, "storage": _choose(item["storage"], chosen)} if item["enum"] == ref["enum"] else item
                for item in design["enums"]
            ],
        }
    if ref["kind"] == "key":
        return _map_model(
            design,
            ref["model"],
            lambda item: {**item, "key": _choose(item["key"], chosen)} if item.get("key") else item,
        )
    kind = ref["kind"]
    return _map_field(
        design,
        ref["model"],
        ref["field"],
        lambda item: {**item, kind: _choose(item[kind], chosen)} if item.get(kind) else item,
    )


def set_model_include(design: dict, model: str, include: bool) -> dict:
    return _map_model(design, model, lambda item: {**item, "include": include})


def set_table_name(design: dict, model: str, table: str) -> dict:
    name = table.strip()

    def change(item: dict) -> dict:
        rest = {key: value for key, value in item.items() if key != "table"}
        return {**rest, "table": name} if name else rest

    return _map_model(design, model, change)


def set_field_include(design: dict, model: str, field: str, include: bool) -> dict:
    return _map_field(design, model, field, lambda item: {**item, "include": include})


def set_field_index(design: dict, model: str, field: str, index: bool) -> dict:
    def change(item: dict) -> dict:
        rest = {key: value for key, value in item.items() if key != "index"}
        return {**rest, "index": True} if index else rest

    return _map_field(design, model, field, change)


def set_field_override(design: dict, model: str, field: str, key: str, value: str) -> dict:
    """A column name or type written by the user; an empty text goes back to the derived one."""
    text = value.strip()

    def change(item: dict) -> dict:
        updated = {name: entry for name, entry in item.items() if name != key}
        if text:
            updated[key] = text
        return updated

    return _map_field(design, model, field, change)


def _keep(fresh: dict | None, old: dict | None) -> dict | None:
    if not fresh or not old or not old.get("manual"):
        return fresh
    if any(same_value(option, old["value"]) for option in fresh["options"]):
        return {**fresh, "value": old["value"], "status": "active", "manual": True}
    return fresh


def reconcile(previous: dict | None, schema: dict, target: str) -> dict:
    """A fresh proposal that keeps everything the user decided wherever it still applies."""
    fresh = propose_design(schema, target)
    if not previous or previous["target"] != target:
        return fresh
    models = []
    for model in fresh["models"]:
        old = next((item for item in previous["models"] if item["model"] == model["model"]), None)
        if not old:
            models.append(model)
            continue
        merged = {**model, "include": old["include"]}
        if old.get("table"):
            merged["table"] = old["table"]
        merged["key"] = _keep(model.get("key"), old.get("key"))
        fields = []
        for field in model["fields"]:
            was = next((item for item in old["fields"] if item["field"] == field["field"]), None)
            if not was:
                fields.append(field)
                continue
            updated = {**field, "include": was["include"]}
            for kind in FIELD_DECISIONS:
                kept = _keep(field.get(kind), was.get(kind))
                if kept:
                    updated[kind] = kept
            if was.get("index"):
                updated["index"] = True
            for key in ("column", "type"):
                if was.get(key):
                    updated[key] = was[key]
            fields.append(updated)
        merged["fields"] = fields
        models.append(merged)
    enums = []
    for item in fresh["enums"]:
        old = next((other for other in previous["enums"] if other["enum"] == item["enum"]), None)
        enums.append({**item, "storage": _keep(item["storage"], old["storage"] if old else None) or item["storage"]})
    return {**fresh, "models": models, "enums": enums}
