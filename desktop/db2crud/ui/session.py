"""What the window shows and works with: the input and what was read from it. Mirrors the state of web/src/App.tsx.
The CRUD design and the generated project come back with the new core (ROADMAP).

Every change emits the signal of what changed, so the panes stay in sync.
"""

from PySide6.QtCore import QObject, QSettings, Signal

from ..core.js import trim
from ..examples import find_example
from ..workspace import EMPTY_INPUT, read_input


class Session(QObject):
    input_changed = Signal()
    message_changed = Signal()

    def __init__(self, settings: QSettings):
        super().__init__()
        # Preferences of the window (language); the user's models are never stored
        self._settings = settings
        self.input = dict(EMPTY_INPUT)
        self.read = read_input(self.input)
        # A message for the user: (text, "ok" | "error"), or None
        self.message: tuple[str, str] | None = None

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
        self.input = state
        self.read = read_input(state)
        self.input_changed.emit()

    def change_input(self, **changes) -> None:
        state = {**self.input, **changes}
        for key in [key for key, value in changes.items() if value is None and key in ("fileName", "receivedFrom")]:
            state.pop(key, None)
        self.set_input(state)

    # Messages

    def set_message(self, text: str | None, kind: str = "ok") -> None:
        self.message = (text, kind) if text else None
        self.message_changed.emit()

    # Examples

    def load_example(self, example_id: str) -> None:
        example = find_example(example_id)
        if not example:
            return
        self.set_message(None)
        self.set_input({"text": example["text"], "format": example["format"]})
