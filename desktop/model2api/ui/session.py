"""What the window shows and works with: the input, the API design with its undo history, the project settings,
the resolved API and the generated files. Mirrors the state of web/src/App.tsx and its hooks (useApiDesign,
useHistory, useProjectSettings).

Every change recomputes what depends on it and emits the signal of what changed, so the panes stay in sync. The
settings are a preference and are always stored (QSettings); the models and the decisions only while the user
turns on "Remember on this computer", as in the web version.
"""

import json

from PySide6.QtCore import QObject, QSettings, QTimer, Signal

from ..core.api.spec import resolve_api
from ..core.compatibility.stack import DEFAULT_SETTINGS, normalize_settings
from ..core.design.edit import pending_decisions
from ..core.design.propose import reconcile
from ..core.generators.registry import generate_project
from ..core.js import trim
from ..core.project.project import create_project, project_file_name, read_project
from ..examples import find_example
from ..workspace import EMPTY_INPUT, input_of_project, read_input

# Enough to undo a long review without keeping every change of a big design forever
HISTORY_LIMIT = 100


def _bool(value) -> bool:
    # QSettings gives back "true" / "false" strings with the INI format
    return value in (True, "true", "1", 1)


def _stored_settings(value) -> dict:
    """The stored settings, made consistent with the matrix: a value from an older version may lack new settings
    or hold options no longer offered."""
    try:
        stored = json.loads(value) if isinstance(value, str) else {}
    except ValueError:
        stored = {}
    if not isinstance(stored, dict):
        stored = {}
    return normalize_settings({**DEFAULT_SETTINGS, **stored})


class Session(QObject):
    input_changed = Signal()
    design_changed = Signal()
    output_changed = Signal()
    message_changed = Signal()
    # The copy kept on this computer was written or deleted
    saved_changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        self._settings = settings
        self.input = dict(EMPTY_INPUT)
        self.read = read_input(self.input)
        self._schema_key = ""
        # The design as the user left it; what the panes show is this design reconciled with the current models
        self._present: dict | None = None
        self._past: list = []
        self._future: list = []
        self.design: dict | None = None
        self.spec: dict | None = None
        self.files: list[dict] = []
        self.pending: list[dict] = []
        # A message for the user: (text, "ok" | "error"), or None
        self.message: tuple[str, str] | None = None
        self.settings = _stored_settings(settings.value("settings"))
        self.remember = _bool(settings.value("remember", False))

        # The copy of the work kept while "remember" is on, written once changes pause
        self._save_timer = QTimer(self)
        self._save_timer.setSingleShot(True)
        self._save_timer.setInterval(600)
        self._save_timer.timeout.connect(self._save_workspace)

    # Input

    @property
    def schema(self) -> dict | None:
        outcome = self.read["outcome"]
        return outcome["schema"] if outcome and outcome["ok"] else None

    def has_work(self) -> bool:
        return trim(self.input["text"]) != ""

    def set_input(self, state: dict) -> None:
        if state == self.input:
            return
        # Clearing the input starts over: the decisions made on the previous models are discarded too
        if trim(state["text"]) == "":
            self._restart(None)
        self.input = state
        self.read = read_input(state)
        self.input_changed.emit()
        self._models_changed()

    def change_input(self, **changes) -> None:
        state = {**self.input, **changes}
        for key in [key for key, value in changes.items() if value is None and key in ("fileName", "receivedFrom")]:
            state.pop(key, None)
        self.set_input(state)

    def _models_changed(self) -> None:
        """The design follows the models only when what was read changes, not on every keystroke."""
        schema = self.schema
        key = json.dumps(schema, sort_keys=True) if schema else ""
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
        schema = self.schema
        if not schema or not self.design:
            return
        changed = reconcile(edit(self.design), schema)
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
            self.change(lambda _design: reconcile(None, self.schema))

    def undo(self) -> None:
        if not self._past:
            return
        self._future.append(self._present)
        self._present = self._past.pop()
        self._update()

    def redo(self) -> None:
        if not self._future:
            return
        self._past.append(self._present)
        self._present = self._future.pop()
        self._update()

    def _restart(self, design: dict | None) -> None:
        """A new starting point (new models, a project): the history starts over."""
        self._past.clear()
        self._future.clear()
        self._present = design

    def _update(self) -> None:
        schema = self.schema
        self.design = reconcile(self._present, schema) if schema else None
        self.pending = pending_decisions(self.design) if self.design else []
        self.spec = resolve_api(schema, self.design, self.settings) if schema and self.design else None
        self.files = generate_project(self.spec, self.settings) if self.spec else []
        self.design_changed.emit()
        self.output_changed.emit()
        if self.remember:
            self._save_timer.start()

    # Settings

    def set_settings(self, **change) -> None:
        settings = normalize_settings({**DEFAULT_SETTINGS, **self.settings, **change})
        if settings == self.settings:
            return
        self.settings = settings
        self._settings.setValue("settings", json.dumps(settings))
        self._update()

    # Messages

    def set_message(self, text: str | None, kind: str = "ok") -> None:
        self.message = (text, kind) if text else None
        self.message_changed.emit()

    # Projects and examples

    def current_project(self) -> dict | None:
        if not self.has_work():
            return None
        state = {**self.input, "format": self.read["format"] or self.input.get("format")}
        return create_project(state, self.design, self.settings)

    def project_file(self) -> tuple[str, str] | None:
        """The current project as (text, suggested file name)."""
        project = self.current_project()
        if not project:
            return None
        return json.dumps(project, ensure_ascii=False, indent=2), project_file_name(self.settings)

    def apply_project(self, project: dict) -> None:
        """Puts a project (a saved file, the copy kept on this computer) in the workspace."""
        self._restart(project["design"])
        self.settings = normalize_settings({**DEFAULT_SETTINGS, **self.settings, **project["settings"]})
        self._settings.setValue("settings", json.dumps(self.settings))
        state = input_of_project(project)
        self.input = state
        self.read = read_input(state)
        self._schema_key = json.dumps(self.schema, sort_keys=True) if self.schema else ""
        self.input_changed.emit()
        self._update()

    def load_example(self, example_id: str) -> None:
        example = find_example(example_id)
        if not example:
            return
        # Different models: the decisions made on the previous ones do not apply
        self._restart(None)
        self._schema_key = ""
        self.settings = normalize_settings({**DEFAULT_SETTINGS, **self.settings, "name": example["project"]})
        self._settings.setValue("settings", json.dumps(self.settings))
        self.set_message(None)
        self.input = {"text": example["text"], "format": example["format"]}
        self.read = read_input(self.input)
        self.input_changed.emit()
        self._models_changed()

    # Work kept on this computer (opt-in)

    def set_remember(self, remember: bool) -> None:
        self.remember = remember
        self._settings.setValue("remember", remember)
        if remember:
            self._save_workspace()
        else:
            # Turning it off drops the copy at once
            self._settings.remove("workspace")
            self.saved_changed.emit()

    def has_saved(self) -> bool:
        return bool(self._settings.value("workspace"))

    def restore_saved(self) -> bool:
        """The work kept on this computer, when the user asked for it."""
        if not self.remember:
            return False
        raw = self._settings.value("workspace")
        read = read_project(raw) if isinstance(raw, str) else None
        if not read or not read["ok"]:
            return False
        self.apply_project(read["project"])
        return True

    def clear_saved(self) -> None:
        self.set_remember(False)

    def _save_workspace(self) -> None:
        if not self.remember:
            return
        project = self.current_project()
        if project:
            self._settings.setValue("workspace", json.dumps(project, ensure_ascii=False))
            self.saved_changed.emit()
