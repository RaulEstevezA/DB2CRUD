"""Immutable edits of an API design: decisions, fields left out, resource paths and endpoints. Every edit
returns a new design and leaves the one it receives as it was. Mirrors web/src/core/design/edit.ts.

A decision reference is {"kind": "expose" | "key", "model"} or {"kind": "access" | "relation" | "unknownType",
"model", "field"}.
"""

import re

from ..api.types import FIELD_DECISIONS, HTTP_METHODS, same_value
from ..js import trim

_MISSING = object()


def _map_resource(design: dict, model: str, change) -> dict:
    return {**design, "resources": [change(item) if item["model"] == model else item for item in design["resources"]]}


def _map_field(design: dict, model: str, field: str, change) -> dict:
    def on_resource(item: dict) -> dict:
        return {**item, "fields": [change(f) if f["field"] == field else f for f in item["fields"]]}

    return _map_resource(design, model, on_resource)


def _choose(current: dict, value) -> dict:
    """The user chooses a value (or confirms the suggestion): the decision becomes active and manual."""
    return {**current, "value": value, "status": "active", "manual": True}


def get_decision(design: dict, ref: dict) -> dict | None:
    """The decision an edit refers to, if the design has it."""
    resource = next((item for item in design["resources"] if item["model"] == ref["model"]), None)
    if resource is None:
        return None
    if ref["kind"] == "expose":
        return resource["expose"]
    if ref["kind"] == "key":
        return resource.get("key")
    field = next((item for item in resource["fields"] if item["field"] == ref.get("field")), None)
    return field.get(ref["kind"]) if field else None


def decide(design: dict, ref: dict, value=_MISSING) -> dict:
    """Chooses the value of a decision, or confirms its suggestion when no value is given. A value the
    decision does not offer is ignored."""
    current = get_decision(design, ref)
    if not current:
        return design
    chosen = current["value"] if value is _MISSING else value
    if not any(same_value(option, chosen) for option in current["options"]):
        return design
    kind = ref["kind"]
    if kind == "expose":
        return _map_resource(design, ref["model"], lambda item: {**item, "expose": _choose(item["expose"], chosen)})
    if kind == "key":
        return _map_resource(
            design,
            ref["model"],
            lambda item: {**item, "key": _choose(item["key"], chosen)} if item.get("key") else item,
        )

    def on_field(item: dict) -> dict:
        current_decision = item.get(kind)
        return {**item, kind: _choose(current_decision, chosen)} if current_decision else item

    return _map_field(design, ref["model"], ref["field"], on_field)


def set_field_include(design: dict, model: str, field: str, include: bool) -> dict:
    """Leaves a field out of the API, or brings it back. The key of a resource always stays."""
    resource = next((item for item in design["resources"] if item["model"] == model), None)
    key = resource.get("key") if resource else None
    if not include and key and key["value"]["kind"] == "field" and key["value"]["field"] == field:
        return design
    return _map_field(design, model, field, lambda item: {**item, "include": include})


_EDGE_SLASHES = re.compile(r"^/+|/+$")
_NOT_PATH = re.compile(r"[^A-Za-z0-9_\-/{}]+")
_HYPHENS = re.compile(r"-+")


def clean_segment(text: str) -> str:
    """Normalizes a path segment written by the user: words joined by hyphens, no slashes at the ends."""
    return _HYPHENS.sub("-", _NOT_PATH.sub("-", _EDGE_SLASHES.sub("", trim(text))))


def set_resource_path(design: dict, model: str, path: str) -> dict:
    """Sets the first segment of a resource's paths; an empty text goes back to the derived one."""
    segment = clean_segment(path).split("/")[0]

    def change(item: dict) -> dict:
        rest = {key: value for key, value in item.items() if key != "path"}
        return {**rest, "path": segment} if segment else rest

    return _map_resource(design, model, change)


def clean_path(text: str) -> str:
    """A path written by the user: starts with a slash, no spaces, no trailing slash."""
    return f"/{clean_segment(text)}"


def update_endpoint(design: dict, model: str, endpoint_id: str, patch: dict) -> dict:
    """Changes an endpoint. A path is normalized; an unknown method is ignored. A key whose value is None is
    removed, as undefined does on the web (status None goes back to the operation's usual status)."""
    changes = dict(patch)
    if changes.get("path") is not None:
        changes["path"] = clean_path(changes["path"])
    if changes.get("method") is not None and changes["method"] not in HTTP_METHODS:
        del changes["method"]
    if changes.get("roles") is not None:
        changes["roles"] = list(dict.fromkeys(role for role in (trim(item) for item in changes["roles"]) if role))

    def on_endpoint(endpoint: dict) -> dict:
        if endpoint["id"] != endpoint_id:
            return endpoint
        changed = dict(endpoint)
        for key, value in changes.items():
            if value is None:
                changed.pop(key, None)
            else:
                changed[key] = value
        if changes.get("path") is not None and endpoint["operation"] != "custom":
            changed["pathEdited"] = True
        return changed

    return _map_resource(design, model, lambda item: {**item, "endpoints": [on_endpoint(e) for e in item["endpoints"]]})


def add_custom_endpoint(design: dict, model: str) -> dict:
    """Adds a business endpoint to a resource, under the path of one item. It starts enabled, receives nothing
    and returns the resource; the user adapts it, and the generated code marks where its logic goes.

    Returns {"design", "id"}: the new design and the identifier of the new endpoint."""
    resource = next((item for item in design["resources"] if item["model"] == model), None)
    if not resource or resource["expose"]["value"] != "resource":
        return {"design": design, "id": ""}
    used = {endpoint["id"] for endpoint in resource["endpoints"]}
    n = 1
    while f"{model}.custom.{n}" in used:
        n += 1
    endpoint_id = f"{model}.custom.{n}"
    get = next((endpoint for endpoint in resource["endpoints"] if endpoint["operation"] == "get"), None)
    item = get["path"] if get else f"/{model.lower()}"
    suffix = "" if n == 1 else str(n)
    endpoint = {
        "id": endpoint_id,
        "operation": "custom",
        "enabled": True,
        "method": "POST",
        "path": f"{item}/action{suffix}",
        "name": f"{model[:1].lower()}{model[1:]}Action{suffix}",
        "summary": "Business operation",
        "access": "default",
        "roles": [],
        "input": "none",
        "output": "resource",
    }
    new_design = _map_resource(
        design, model, lambda current: {**current, "endpoints": [*current["endpoints"], endpoint]}
    )
    return {"design": new_design, "id": endpoint_id}


def remove_endpoint(design: dict, model: str, endpoint_id: str) -> dict:
    """Removes a business endpoint. Standard endpoints are disabled instead, never removed."""

    def change(item: dict) -> dict:
        endpoints = [e for e in item["endpoints"] if e["id"] != endpoint_id or e["operation"] != "custom"]
        return {**item, "endpoints": endpoints}

    return _map_resource(design, model, change)


def pending_decisions(design: dict) -> list[dict]:
    """Every decision that waits for the user, in the order of the design."""
    pending: list[dict] = []
    for resource in design["resources"]:
        if resource["expose"]["status"] == "pending":
            pending.append({"kind": "expose", "model": resource["model"]})
        key = resource.get("key")
        if resource["expose"]["value"] == "resource" and key and key["status"] == "pending":
            pending.append({"kind": "key", "model": resource["model"]})
        for field in resource["fields"]:
            if not field["include"]:
                continue
            for kind in FIELD_DECISIONS:
                if field.get(kind) and field[kind]["status"] == "pending":
                    pending.append({"kind": kind, "model": resource["model"], "field": field["field"]})
    return pending
