"""Workspace logic the window uses, kept out of the widgets so it can be tested: reading the database input and
counting what was read. Mirrors web/src/app/workspace.ts.

An input is {"text", "fileName"?}. A read is {"ok": True, "schema"} or {"ok": False, "error", "path"?}.
"""

from .core.importers.orm.registry import ORM_READERS, detect_orm, read_orm_code
from .core.interop.model2db.read import read_model2db_project
from .core.js import coalesce, trim, trim_start

EMPTY_INPUT = {"text": ""}


def read_database(state: dict) -> dict | None:
    """The physical schema of the input, or why it cannot be read; None while the input is empty. A JSON text is a
    Model2DB project; anything else is ORM code."""
    text = trim(state["text"])
    if text == "":
        return None
    if text.startswith("{"):
        return read_model2db_project(state["text"])
    read = read_orm_code([{"name": coalesce(state.get("fileName"), "input"), "text": state["text"]}])
    if read["ok"]:
        return {"ok": True, "schema": read["schema"]}
    return {"ok": False, "error": "unknownInput" if read["error"] == "unknownOrm" else read["error"]}


def input_language(state: dict) -> str:
    """The language of the input, for the editor's highlighting: JSON for a project, the ORM's for its code."""
    text = trim_start(state["text"])
    if text == "" or text.startswith("{"):
        return "json"
    reader = detect_orm([{"name": coalesce(state.get("fileName"), "input"), "text": state["text"]}])
    return reader.language if reader else "text"


def source_label(schema: dict) -> str:
    """What the schema was read from, for the summary: `Model2DB (prisma)`, `SQLAlchemy`."""
    kind, form = schema["source"]["kind"], schema["source"]["format"]
    if kind == "model2db":
        return f"Model2DB ({form})"
    return next((reader.label for reader in ORM_READERS if reader.id == form), form)


def column_count(schema: dict) -> int:
    """Count of columns in every table."""
    return sum(len(table["columns"]) for table in schema["tables"])
