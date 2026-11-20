"""Reads a saved Mapper project (`mapper-project`, version 1; Mapper's docs/interoperability.md): both models, as
Mapper read them, and the mapping between them, field by field with its transformation. DB2CRUD uses it as the
application models: one side is the model of a table, the other the model the services take or return
(matching/mapper.py). Everything used is checked, and a damaged file is rejected with the path of the problem.
Mirrors web/src/core/interop/mapper/read.ts.

A project is {source, target: {format, model, schema}, root, mappings: [{id, source, target, fields: [{target,
sources, transform, status}], ignoredSources}]}."""

import json
import re

from ...importers.schema.model_schema import validate_model_schema

MAPPER_PROJECT_FORMAT = "mapper-project"
MAPPER_PROJECT_VERSION = 1

_TRANSFORMS = {
    "direct",
    "concat",
    "split",
    "constant",
    "boolean",
    "enum",
    "epoch",
    "arithmetic",
    "object",
    "collection",
    "expression",
}
_STATUSES = {"active", "pending", "ignored", "unmapped"}


def _is_string_list(value) -> bool:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def is_mapper_project(text: str) -> bool:
    """Whether a text is a Mapper project, before reading it whole."""
    return bool(re.match(r"\s*\{", text)) and bool(re.search(r'"format"\s*:\s*"mapper-project"', text))


def _read_side(value, path: str) -> dict | str:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("format"), str)
        or not isinstance(value.get("model"), str)
    ):
        return path
    schema = validate_model_schema(value.get("schema"))
    if not schema["ok"]:
        return f"{path}.schema{schema['path'][1:]}"
    return {"format": value["format"], "model": value["model"], "schema": schema["schema"]}


def _read_mappings(value, path: str) -> dict | str:
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("root"), str)
        or not isinstance(value.get("mappings"), list)
    ):
        return path
    mappings = []
    for index, mapping in enumerate(value["mappings"]):
        at = f"{path}.mappings[{index}]"
        if (
            not isinstance(mapping, dict)
            or not isinstance(mapping.get("id"), str)
            or not isinstance(mapping.get("source"), str)
            or not isinstance(mapping.get("target"), str)
            or not isinstance(mapping.get("fields"), list)
        ):
            return at
        ignored = mapping.get("ignoredSources", [])
        if not _is_string_list(ignored):
            return f"{at}.ignoredSources"
        fields = []
        for field_index, field in enumerate(mapping["fields"]):
            field_path = f"{at}.fields[{field_index}]"
            if not isinstance(field, dict) or not isinstance(field.get("target"), str):
                return field_path
            sources = field.get("sources")
            if not isinstance(sources, list) or not all(_is_string_list(item) for item in sources):
                return f"{field_path}.sources"
            transform = field.get("transform")
            if not isinstance(transform, dict) or str(transform.get("kind")) not in _TRANSFORMS:
                return f"{field_path}.transform"
            if str(field.get("status")) not in _STATUSES:
                return f"{field_path}.status"
            fields.append(
                {"target": field["target"], "sources": sources, "transform": transform, "status": field["status"]}
            )
        mappings.append(
            {
                "id": mapping["id"],
                "source": mapping["source"],
                "target": mapping["target"],
                "fields": fields,
                "ignoredSources": ignored,
            }
        )
    if not any(mapping["id"] == value["root"] for mapping in mappings):
        return f"{path}.root"
    return {"root": value["root"], "mappings": mappings}


def read_mapper_project(text: str) -> dict:
    """Reads a Mapper project: {ok: True, project} or {ok: False, error, path?}."""
    try:
        value = json.loads(text)
    except ValueError:
        return {"ok": False, "error": "notJson"}
    if not isinstance(value, dict) or value.get("format") != MAPPER_PROJECT_FORMAT:
        return {"ok": False, "error": "notProject"}
    version = value.get("version")
    if not isinstance(version, int | float) or isinstance(version, bool) or version > MAPPER_PROJECT_VERSION:
        return {"ok": False, "error": "newerVersion"}
    source = _read_side(value.get("source"), "$.source")
    if isinstance(source, str):
        return {"ok": False, "error": "invalid", "path": source}
    target = _read_side(value.get("target"), "$.target")
    if isinstance(target, str):
        return {"ok": False, "error": "invalid", "path": target}
    mapping = _read_mappings(value.get("mapping"), "$.mapping")
    if isinstance(mapping, str):
        return {"ok": False, "error": "invalid", "path": mapping}
    return {"ok": True, "project": {"source": source, "target": target, **mapping}}


def mapper_models(project: dict) -> dict:
    """The models of both sides in one schema, each name once (the source's first): what the matching compares."""
    source, target = project["source"]["schema"], project["target"]["schema"]
    models = list(source["models"])
    for model in target["models"]:
        if not any(item["name"] == model["name"] for item in models):
            models.append(model)
    enums = list(source["enums"])
    for item in target["enums"]:
        if not any(other["name"] == item["name"] for other in enums):
            enums.append(item)
    return {**source, "models": models, "enums": enums}


def invertible(transform: dict) -> bool:
    """Whether a transformation can be undone without loss, so the same relation serves the other direction: a value
    renamed or converted, an enum whose pairs are one to one, a date as seconds, a number scaled or shifted."""
    kind = transform["kind"]
    if kind in ("direct", "epoch"):
        return True
    if kind == "arithmetic":
        return transform.get("operand") != 0
    if kind == "enum":
        targets = [pair["to"] for pair in transform.get("pairs", [])]
        return transform.get("fallback") is None and len(set(targets)) == len(targets)
    return False
