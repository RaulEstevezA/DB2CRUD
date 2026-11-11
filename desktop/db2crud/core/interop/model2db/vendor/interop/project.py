"""A saved Model2DB project: the input as written, the decisions of both kinds of database and the output
settings. Mirrors web/src/core/interop/project.ts; a project saved in one version opens in the other
(docs/interoperability.md)."""

import re
from datetime import UTC, datetime

from ..design.types import FIELD_DECISIONS, per_target
from ..js import parse_json_value
from ..parsers.registry import find_parser
from ..physical.naming import DEFAULT_NAMING

PROJECT_FORMAT = "model2db-project"
PROJECT_VERSION = 1

STATUSES = ("active", "pending")
CONFIDENCES = ("exact", "high", "probable", "review", "conflict", "none")
TABLE_NAMING = ("plural", "singular", "model")
COLUMN_NAMING = ("snake", "field")
STRINGS = ("auto", "varchar", "text")
DIALECTS = ("postgresql", "mysql", "mariadb", "sqlite", "sqlserver", "oracle")

# A key that is not there, which JavaScript reads as undefined (null is None)
_MISSING = object()


def create_project(project_input: dict, designs: dict, output: dict, now: datetime | None = None) -> dict:
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    saved_at = moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
    entry = {"format": project_input.get("format"), "text": project_input["text"]}
    if project_input.get("fileName"):
        entry["fileName"] = project_input["fileName"]
    return {
        "format": PROJECT_FORMAT,
        "version": PROJECT_VERSION,
        "savedAt": saved_at,
        "input": entry,
        "designs": designs,
        "output": output,
    }


class _Invalid(Exception):
    """A problem in the file, with the path of the first wrong value."""

    def __init__(self, path: str):
        super().__init__(path)
        self.path = path


def _check(condition: bool, path: str) -> None:
    if not condition:
        raise _Invalid(path)


def _is_object(value) -> bool:
    return isinstance(value, dict)


def _is_bool(value) -> bool:
    return isinstance(value, bool)


def _optional_string(value, path: str) -> str | None:
    _check(value is _MISSING or isinstance(value, str), path)
    return None if value is _MISSING else value


def _read_decision(value, path: str) -> dict | None:
    """A decision as saved. Its value is checked against the schema when the design is reconciled
    (design/edit.py): a value the proposal no longer offers is dropped there."""
    if value is _MISSING:
        return None
    _check(_is_object(value), path)
    _check(value.get("status") in STATUSES, f"{path}.status")
    _check(value.get("confidence") in CONFIDENCES, f"{path}.confidence")
    _check(isinstance(value.get("options"), list), f"{path}.options")
    reasons = value.get("reasons")
    _check(
        isinstance(reasons, list) and all(_is_object(item) and isinstance(item.get("code"), str) for item in reasons),
        f"{path}.reasons",
    )
    manual = value.get("manual", _MISSING)
    _check(manual is _MISSING or _is_bool(manual), f"{path}.manual")
    result = {}
    if "value" in value:
        result["value"] = value["value"]
    result.update({"status": value["status"], "confidence": value["confidence"]})
    if manual is True:
        result["manual"] = True
    result.update({"reasons": reasons, "options": value["options"]})
    return result


def _read_field(value, path: str) -> dict:
    _check(_is_object(value) and isinstance(value.get("field"), str) and _is_bool(value.get("include")), path)
    result = {"field": value["field"], "include": value["include"]}
    for kind in FIELD_DECISIONS:
        decision = _read_decision(value.get(kind, _MISSING), f"{path}.{kind}")
        if decision:
            result[kind] = decision
    index = value.get("index", _MISSING)
    _check(index is _MISSING or _is_bool(index), f"{path}.index")
    if index is True:
        result["index"] = True
    for key in ("column", "type"):
        text = _optional_string(value.get(key, _MISSING), f"{path}.{key}")
        if text:
            result[key] = text
    return result


def _read_model(value, path: str) -> dict:
    _check(
        _is_object(value)
        and isinstance(value.get("model"), str)
        and _is_bool(value.get("include"))
        and isinstance(value.get("fields"), list),
        path,
    )
    result = {
        "model": value["model"],
        "include": value["include"],
        "fields": [_read_field(field, f"{path}.fields[{index}]") for index, field in enumerate(value["fields"])],
    }
    key = _read_decision(value.get("key", _MISSING), f"{path}.key")
    if key:
        result["key"] = key
    table = _optional_string(value.get("table", _MISSING), f"{path}.table")
    if table:
        result["table"] = table
    return result


def _read_enum(value, path: str) -> dict:
    _check(_is_object(value) and isinstance(value.get("enum"), str), path)
    storage = _read_decision(value.get("storage", _MISSING), f"{path}.storage")
    _check(storage is not None, f"{path}.storage")
    return {"enum": value["enum"], "storage": storage}


def _read_design(value, target: str, path: str) -> dict | None:
    if value is None:
        return None
    _check(
        _is_object(value)
        and value.get("target") == target
        and isinstance(value.get("models"), list)
        and isinstance(value.get("enums"), list),
        path,
    )
    return {
        "target": target,
        "models": [_read_model(model, f"{path}.models[{index}]") for index, model in enumerate(value["models"])],
        "enums": [_read_enum(item, f"{path}.enums[{index}]") for index, item in enumerate(value["enums"])],
    }


def _read_naming(value, path: str) -> dict:
    _check(_is_object(value) and value.get("tables") in TABLE_NAMING and value.get("columns") in COLUMN_NAMING, path)
    return {"tables": value["tables"], "columns": value["columns"]}


def _read_output(value, path: str) -> dict:
    _check(_is_object(value) and isinstance(value.get("output"), str), path)
    _check(_is_object(value.get("naming")), f"{path}.naming")
    naming = value["naming"]
    _check(value.get("strings") in STRINGS, f"{path}.strings")
    _check(value.get("engine") in DIALECTS, f"{path}.engine")
    _check(_is_bool(value.get("migrations")), f"{path}.migrations")
    return {
        "output": value["output"],
        # Projects saved before a kind of database existed have no naming for it
        "naming": per_target(
            lambda target: (
                DEFAULT_NAMING[target]
                if naming.get(target) is None and target not in ("relational", "document")
                else _read_naming(naming.get(target), f"{path}.naming.{target}")
            )
        ),
        "strings": value["strings"],
        "engine": value["engine"],
        "migrations": value["migrations"],
    }


def _read_input(value, path: str) -> dict:
    _check(_is_object(value) and isinstance(value.get("text"), str), path)
    format_id = value.get("format", _MISSING)
    _check(format_id is None or (isinstance(format_id, str) and find_parser(format_id) is not None), f"{path}.format")
    file_name = _optional_string(value.get("fileName", _MISSING), f"{path}.fileName")
    result = {"format": format_id, "text": value["text"]}
    if file_name:
        result["fileName"] = file_name
    return result


def read_project(text: str) -> dict:
    """Reads a project file. Everything is checked and copied: a damaged or edited file is rejected with the
    path of the first problem instead of breaking the application later, and unknown keys are left behind."""
    try:
        value = parse_json_value(text)
    except (ValueError, RecursionError):
        return {"ok": False, "error": "notJson"}
    if not _is_object(value) or value.get("format") != PROJECT_FORMAT:
        return {"ok": False, "error": "notProject"}
    version = value.get("version")
    if not isinstance(version, (int, float)) or _is_bool(version) or version > PROJECT_VERSION:
        return {"ok": False, "error": "newerVersion"}
    try:
        designs = value.get("designs", _MISSING)
        _check(_is_object(designs), "$.designs")
        project = {
            "format": PROJECT_FORMAT,
            "version": PROJECT_VERSION,
            "savedAt": value["savedAt"] if isinstance(value.get("savedAt"), str) else "",
            "input": _read_input(value.get("input", _MISSING), "$.input"),
            "designs": per_target(lambda target: _read_design(designs.get(target), target, f"$.designs.{target}")),
            "output": _read_output(value.get("output", _MISSING), "$.output"),
        }
    except _Invalid as error:
        return {"ok": False, "error": "invalid", "path": error.path}
    return {"ok": True, "project": project}


def project_file_name(title: str | None) -> str:
    """`order.model2db.json`, from the model the project is mainly about."""
    base = re.sub(r"[^\w.-]+", "-", title or "model", flags=re.ASCII).lower() or "model"
    return f"{base}.model2db.json"
