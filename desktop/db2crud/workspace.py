"""Workspace logic the window uses, kept out of the widgets so it can be tested: reading the database input and
counting what was read. Mirrors web/src/app/workspace.ts.

An input is {"text", "fileName"?}.
"""

from .core.interop.model2db.read import read_model2db_project
from .core.js import trim

EMPTY_INPUT = {"text": ""}


def read_database(state: dict) -> dict | None:
    """The physical schema of the input, or why it cannot be read; None while the input is empty."""
    return None if trim(state["text"]) == "" else read_model2db_project(state["text"])


def column_count(schema: dict) -> int:
    """Count of columns in every table."""
    return sum(len(table["columns"]) for table in schema["tables"])
