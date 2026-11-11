"""Workspace logic the window uses, kept out of the widgets so it can be tested: reading the input with its chosen
or detected format, counting what was read. Mirrors web/src/app/workspace.ts.

An input is {"text", "format", "fileName"?}: a format of None is detected from the text.
"""

from .core.importers.registry import detect_format, parse_input
from .core.js import trim
from .core.model.schema import all_fields

EMPTY_INPUT = {"text": "", "format": None}


def read_input(state: dict) -> dict:
    """Reads the input with its chosen or detected format: {"format", "outcome"}. No outcome while the input is
    empty or its format unknown. A schema without models is reported as noModels: there is nothing to make an
    API of."""
    if trim(state["text"]) == "":
        return {"format": state.get("format"), "outcome": None}
    format_id = state.get("format") or detect_format(state["text"], state.get("fileName"))
    if not format_id:
        return {"format": None, "outcome": None}
    outcome = parse_input(state["text"], format_id, {"rootName": "Root"})
    if outcome["ok"] and len(outcome["schema"]["models"]) == 0:
        return {"format": format_id, "outcome": {"ok": False, "error": {"code": "noModels"}}}
    return {"format": format_id, "outcome": outcome}


def field_count(schema: dict) -> int:
    """Count of fields in every model, inherited ones included."""
    return sum(len(all_fields(schema, model)) for model in schema["models"])
