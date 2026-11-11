"""Model2API project files: the input as written, the reviewed design and the project settings, so the review
can continue later or on another computer. A file is untrusted input: it is validated piece by piece, and a
damaged decision or endpoint is dropped (the proposal fills it again) instead of trusted. Mirrors
web/src/core/project/project.ts.
"""

import json
from datetime import UTC, datetime

from ..api.types import HTTP_METHODS
from ..compatibility.stack import DEFAULT_SETTINGS, normalize_settings
from ..importers.registry import find_parser
from ..js import is_number, js_string, parse_json_value

PROJECT_FORMAT = "model2api-project"
PROJECT_VERSION = 1


def _iso(moment: datetime) -> str:
    """Date.prototype.toISOString: UTC with milliseconds and a Z."""
    moment = moment.astimezone(UTC)
    return f"{moment:%Y-%m-%dT%H:%M:%S}.{moment.microsecond // 1000:03d}Z"


def create_project(input_: dict, design: dict | None, settings: dict, now: datetime | None = None) -> dict:
    """A project to save: {"format", "version", "savedAt", "input", "design", "settings"}. The input is
    {"format", "text", "fileName"?}; a format of None is detected from the text when the project is opened."""
    saved_input = {"format": input_.get("format"), "text": input_["text"]}
    if input_.get("fileName"):
        saved_input["fileName"] = input_["fileName"]
    return {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "savedAt": _iso(now or datetime.now(UTC)),
        "input": saved_input,
        "design": design,
        "settings": settings,
    }


def project_file_name(settings: dict) -> str:
    """File name of a saved project: shop-api.model2api.json."""
    return f"{settings['name']}.model2api.json"


def _is_object(value) -> bool:
    return isinstance(value, dict)


def _is_string(value) -> bool:
    return isinstance(value, str)


_CONFIDENCES = {"exact", "high", "probable", "review", "conflict", "none"}


def _is_decision(value) -> bool:
    return (
        _is_object(value)
        and "value" in value
        and value.get("status") in ("active", "pending")
        and js_string(value.get("confidence")) in _CONFIDENCES
        and isinstance(value.get("reasons"), list)
        and all(_is_object(reason) and _is_string(reason.get("code")) for reason in value["reasons"])
        and isinstance(value.get("options"), list)
    )


def _read_field(value) -> dict | None:
    if not _is_object(value) or not _is_string(value.get("field")) or not isinstance(value.get("include"), bool):
        return None
    if not _is_decision(value.get("access")):
        return None
    field = {"field": value["field"], "include": value["include"], "access": value["access"]}
    for kind in ("relation", "unknownType"):
        if _is_decision(value.get(kind)):
            field[kind] = value[kind]
    return field


_OPERATIONS = {"list", "get", "create", "replace", "update", "delete", "custom"}
_ACCESS = {"default", "public", "authenticated", "roles"}


def _read_endpoint(value) -> dict | None:
    if not _is_object(value):
        return None
    if not _is_string(value.get("id")) or js_string(value.get("operation")) not in _OPERATIONS:
        return None
    if not isinstance(value.get("enabled"), bool) or value.get("method") not in HTTP_METHODS:
        return None
    if not all(_is_string(value.get(key)) for key in ("path", "name", "summary")):
        return None
    roles = value.get("roles")
    if js_string(value.get("access")) not in _ACCESS or not isinstance(roles, list) or not all(map(_is_string, roles)):
        return None
    endpoint = {
        key: value[key] for key in ("id", "operation", "enabled", "method", "path", "name", "summary", "access")
    }
    endpoint["roles"] = roles
    if value.get("pathEdited") is True:
        endpoint["pathEdited"] = True
    if is_number(value.get("status")):
        endpoint["status"] = value["status"]
    if isinstance(value.get("pagination"), bool):
        endpoint["pagination"] = value["pagination"]
    for key in ("filters", "sort"):
        if isinstance(value.get(key), list) and all(map(_is_string, value[key])):
            endpoint[key] = value[key]
    if value.get("input") in ("none", "resource", "partial"):
        endpoint["input"] = value["input"]
    if value.get("output") in ("none", "resource", "list"):
        endpoint["output"] = value["output"]
    return endpoint


def _read_resource(value) -> dict | None:
    if not _is_object(value) or not _is_string(value.get("model")) or not _is_decision(value.get("expose")):
        return None
    fields = value.get("fields")
    endpoints = value.get("endpoints")
    resource = {
        "model": value["model"],
        "expose": value["expose"],
        "fields": [item for item in map(_read_field, fields) if item] if isinstance(fields, list) else [],
        "endpoints": [item for item in map(_read_endpoint, endpoints) if item] if isinstance(endpoints, list) else [],
    }
    if _is_decision(value.get("key")):
        resource["key"] = value["key"]
    if _is_string(value.get("path")) and value["path"] != "":
        resource["path"] = value["path"]
    return resource


def _reject_constant(name: str):
    raise ValueError(f"{name} is not JSON")


def read_project(text: str) -> dict:
    """Reads a project file: {"ok": True, "project"} or {"ok": False, "error"} with notJson, notProject,
    newerVersion or noInput. Settings are normalized; a damaged design keeps only its valid parts."""
    try:
        json.loads(text, parse_constant=_reject_constant)
        data = parse_json_value(text)
    except ValueError:
        return {"ok": False, "error": "notJson"}
    if not _is_object(data) or data.get("format") != PROJECT_FORMAT or not is_number(data.get("version")):
        return {"ok": False, "error": "notProject"}
    if data["version"] > PROJECT_VERSION:
        return {"ok": False, "error": "newerVersion"}
    input_ = data.get("input")
    if not _is_object(input_) or not _is_string(input_.get("text")):
        return {"ok": False, "error": "noInput"}
    input_format = input_.get("format")
    known = _is_string(input_format) and find_parser(input_format)
    design_data = data.get("design")
    design = None
    if _is_object(design_data) and isinstance(design_data.get("resources"), list):
        design = {"resources": [item for item in map(_read_resource, design_data["resources"]) if item]}
    settings = normalize_settings(
        {**DEFAULT_SETTINGS, **(data["settings"] if _is_object(data.get("settings")) else {})}
    )
    project_input = {"format": input_format if known else None, "text": input_["text"]}
    if _is_string(input_.get("fileName")):
        project_input["fileName"] = input_["fileName"]
    return {
        "ok": True,
        "project": {
            "format": PROJECT_FORMAT,
            "version": PROJECT_VERSION,
            "savedAt": data["savedAt"] if _is_string(data.get("savedAt")) else "",
            "input": project_input,
            "design": design,
            "settings": settings,
        },
    }
