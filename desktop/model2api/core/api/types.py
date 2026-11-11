"""The API design: resources, endpoints and the decisions behind them, each with its confidence, its reasons
and its options. Mirrors web/src/core/api/types.ts.

Designs are dictionaries with the same keys as the JSON of the web version:
{"resources": [{"model", "expose", "fields", "endpoints", "key"?, "path"?}]}, where a decision is
{"value", "status", "confidence", "reasons", "options", "manual"?}.
"""

import json

FIELD_DECISIONS = ("access", "relation", "unknownType")

HTTP_METHODS = ("GET", "POST", "PUT", "PATCH", "DELETE")

CRUD_OPERATIONS = ("list", "get", "create", "replace", "update", "delete")


def find_resource(design: dict, model: str) -> dict | None:
    return next((item for item in design["resources"] if item["model"] == model), None)


def find_field_design(design: dict, model: str, field: str) -> dict | None:
    resource = find_resource(design, model)
    return next((item for item in resource["fields"] if item["field"] == field), None) if resource else None


def same_value(a, b) -> bool:
    """Whether two decision values are the same (they are plain JSON, compared as text like the web)."""
    return json.dumps(a) == json.dumps(b)


def decision(value, confidence: str, reasons: list[dict], options: list) -> dict:
    """A proposal: review and conflict wait for the user, the others are applied."""
    status = "pending" if confidence in ("review", "conflict") else "active"
    return {"value": value, "status": status, "confidence": confidence, "reasons": reasons, "options": options}


def reason(code: str, params: dict | None = None) -> dict:
    return {"code": code, "params": params} if params is not None else {"code": code}
