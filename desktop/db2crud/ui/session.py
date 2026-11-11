"""What the window shows and works with: the input and what was read from it, the CRUD design with its undo history,
the project settings and the generated files. Mirrors the state of web/src/App.tsx and its hooks (useCrudDesign,
useHistory, the stored settings).

Every change recomputes what depends on it and emits the signal of what changed, so the panes stay in sync. The
settings are a preference and are stored (QSettings); the database never is.
"""

import json

from PySide6.QtCore import QObject, QSettings, Signal

from ..core.crud.edit import pending_decisions
from ..core.crud.propose import propose_crud
from ..core.generators.registry import generate_project
from ..core.js import trim
from ..core.settings.settings import DEFAULT_SETTINGS, normalize_settings
from ..examples import find_example
from ..workspace import EMPTY_INPUT, read_database

# Enough to undo a long review without keeping every change of a big design forever
HISTORY_LIMIT = 100


def _stored_settings(value) -> dict:
    """The stored settings, made consistent: a value from an older version may lack settings or hold old options."""
    try:
        stored = json.loads(value) if isinstance(value, str) else {}
    except ValueError:
        stored = {}
    return normalize_settings({**DEFAULT_SETTINGS, **(stored if isinstance(stored, dict) else {})})


class Session(QObject):
    input_changed = Signal()
    design_changed = Signal()
    output_changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        self._settings = settings
        self.input = dict(EMPTY_INPUT)
        self.read = read_database(self.input)
        self._schema_key = ""
        # The design as the user left it; what the panes show is this design proposed again on the current schema
        self._present: dict | None = None
        self._past: list = []
        self._future: list = []
        self.design: dict | None = None
        self.pending: list[dict] = []
        self.files: list[dict] = []
        self.settings = _stored_settings(settings.value("settings"))

    # Input

    @property
    def schema(self) -> dict | None:
        read = self.read
        return read["schema"] if read and read["ok"] else None

    def has_work(self) -> bool:
        return trim(self.input["text"]) != ""

    def set_input(self, state: dict) -> None:
        if state == self.input:
            return
        # Clearing the input starts over: the decisions made on the previous database are discarded too
        if trim(state["text"]) == "":
            self._restart()
        self.input = state
        self.read = read_database(state)
        self.input_changed.emit()
        self._schema_changed()

    def _schema_changed(self) -> None:
        """The design follows the schema only when what was read changes, not on every keystroke."""
        key = json.dumps(self.schema, sort_keys=True) if self.schema else ""
        if key == self._schema_key:
            return
        self._schema_key = key
        self._update()

    # Design and history

    @property
    def can_undo(self) -> bool:
        return bool(self._past)

    @property
    def can_redo(self) -> bool:
        return bool(self._future)

    def change(self, edit) -> None:
        """Applies an edit (a function of the design that returns the new design); it can be undone."""
        if not self.schema or not self.design:
            return
        changed = propose_crud(self.schema, edit(self.design))
        if changed == self.design:
            return
        self._past.append(self._present)
        del self._past[:-HISTORY_LIMIT]
        self._future.clear()
        self._present = changed
        self._update()

    def reset_design(self) -> None:
        """Back to the proposal, keeping nothing the user decided; it can be undone."""
        if self.schema:
            self.change(lambda _design: propose_crud(self.schema))

    def undo(self) -> None:
        if self._past:
            self._future.append(self._present)
            self._present = self._past.pop()
            self._update()

    def redo(self) -> None:
        if self._future:
            self._past.append(self._present)
            self._present = self._future.pop()
            self._update()

    def _restart(self) -> None:
        """Another database: the history starts over."""
        self._past.clear()
        self._future.clear()
        self._present = None

    def _update(self) -> None:
        schema = self.schema
        self.design = propose_crud(schema, self._present) if schema else None
        self.pending = pending_decisions(self.design) if self.design else []
        self.design_changed.emit()
        self._generate()

    def _generate(self) -> None:
        schema = self.schema
        self.files = generate_project(schema, self.design, self.settings) if schema and self.design else []
        self.output_changed.emit()

    # Settings

    def set_settings(self, **change) -> None:
        settings = normalize_settings({**self.settings, **change})
        if settings == self.settings:
            return
        self.settings = settings
        self._settings.setValue("settings", json.dumps(settings))
        self._generate()

    # Examples

    def load_example(self, example_id: str) -> None:
        example = find_example(example_id)
        if not example:
            return
        self._restart()
        self._schema_key = ""
        self.set_settings(name=example["project"])
        self.input = {"text": example["text"], "fileName": f"{example['project']}.model2db.json"}
        self.read = read_database(self.input)
        self.input_changed.emit()
        self._schema_changed()
