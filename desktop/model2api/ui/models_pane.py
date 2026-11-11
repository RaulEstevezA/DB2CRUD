"""The models to make an API of: editor, open, clear, format and the reading status. Read on this computer and never
sent anywhere. Mirrors web/src/components/models/ModelsPane.tsx."""

from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QComboBox, QFileDialog, QHBoxLayout, QLabel, QPushButton

from ..core.importers.registry import PARSERS, accepted_extensions, detect_format, find_parser
from ..core.js import trim
from ..workspace import field_count
from .code_view import CodeView
from .i18n import I18n
from .pane import Pane, section
from .session import Session

# Far above any model or example document; avoids freezing the window with a huge file opened by mistake
MAX_FILE_SIZE = 10 * 1024 * 1024


class InputEditor(CodeView):
    """Editor that opens files dropped on it instead of inserting their path."""

    file_dropped = Signal(str)

    def dragEnterEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragEnterEvent(event)

    def dragMoveEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        if event.mimeData().hasUrls():
            event.acceptProposedAction()
        else:
            super().dragMoveEvent(event)

    def dropEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        urls = event.mimeData().urls()
        if urls and urls[0].isLocalFile():
            event.acceptProposedAction()
            self.file_dropped.emit(urls[0].toLocalFile())
        else:
            super().dropEvent(event)


class ModelsPane(Pane):
    def __init__(self, i18n: I18n, session: Session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        self._file_error: str | None = None
        self._updating = False

        self.open_button = QPushButton()
        self.open_button.clicked.connect(self.choose_file)
        self.clear_button = QPushButton()
        self.clear_button.clicked.connect(self._clear)
        for button in (self.open_button, self.clear_button):
            self.header.addWidget(button)

        settings = section()
        row = QHBoxLayout(settings)
        row.setContentsMargins(14, 0, 14, 10)
        self.format_label = QLabel()
        self.format_label.setProperty("role", "fieldLabel")
        self.format = QComboBox()
        self.format.currentIndexChanged.connect(self._format_chosen)
        self.format_label.setBuddy(self.format)
        row.addWidget(self.format_label)
        row.addWidget(self.format, 1)
        self.body.addWidget(settings)

        self.editor = InputEditor("text")
        self.editor.file_dropped.connect(self.open_file)
        self.editor.textChanged.connect(self._typed)
        self.body.addWidget(self.editor, 1)
        self.status = QLabel()
        self.status.setWordWrap(True)
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.footer.addWidget(self.status, 1)

        # Large inputs are read once typing pauses, so the editor stays smooth
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(250)
        self._timer.timeout.connect(self._commit_text)

        i18n.changed.connect(self.refresh)
        session.input_changed.connect(self.refresh)
        self.refresh()

    # Actions

    def choose_file(self) -> None:
        t = self._i18n.t
        patterns = " ".join(f"*{extension}" for extension in accepted_extensions())
        path, _ = QFileDialog.getOpenFileName(
            self, t.open_dialog, "", f"{t.model_files} ({patterns});;{t.all_files} (*)"
        )
        if path:
            self.open_file(path)

    def open_file(self, path: str) -> None:
        """Read on this computer: the file is never sent anywhere."""
        t = self._i18n.t
        file = Path(path)
        try:
            if file.stat().st_size > MAX_FILE_SIZE:
                self._show_file_error(t.file_too_large(file.name))
                return
            text = file.read_text(encoding="utf-8-sig")
        except (OSError, UnicodeDecodeError):
            self._show_file_error(t.file_error(file.name))
            return
        self._file_error = None
        self._session.set_input({"text": text, "format": None, "fileName": file.name})

    def set_text(self, text: str) -> None:
        self.editor.setPlainText(text)
        self._commit_text()

    def _show_file_error(self, text: str) -> None:
        self._file_error = text
        self.refresh()

    def _clear(self) -> None:
        self._file_error = None
        self._session.set_input({"text": "", "format": None})

    def _typed(self) -> None:
        if not self._updating:
            self._file_error = None
            self._timer.start()

    def _commit_text(self) -> None:
        self._timer.stop()
        text = self.editor.toPlainText()
        if text != self._session.input["text"]:
            self._session.change_input(text=text, receivedFrom=None)

    def _format_chosen(self) -> None:
        if not self._updating:
            self._commit_text()
            self._session.change_input(format=self.format.currentData())

    # Display

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        state = session.input
        read = session.read
        self._updating = True
        self.title.setText(t.workspace_parts["models"])
        self.open_button.setText(t.open_file)
        self.clear_button.setText(t.clear)
        self.clear_button.setEnabled(state["text"] != "")
        self.format_label.setText(t.format_label)
        self.editor.setPlaceholderText(t.input_placeholder)
        self.editor.setAccessibleName(t.input_label)
        self.editor.setAccessibleDescription(t.editor_keys)
        # Text being typed is not replaced: it reaches the session once typing pauses
        if self.editor.toPlainText() != state["text"] and not self._timer.isActive():
            self.editor.setPlainText(state["text"])

        detected = detect_format(state["text"], state.get("fileName")) if trim(state["text"]) else None
        detected_parser = find_parser(detected) if detected else None
        self.format.clear()
        self.format.addItem(t.format_auto(detected_parser.label if detected_parser else detected), None)
        for parser in PARSERS:
            self.format.addItem(parser.label, parser.id)
        self.format.setCurrentIndex(max(0, self.format.findData(state["format"])) if state["format"] else 0)

        outcome = read["outcome"]
        parser = find_parser(read["format"]) if read["format"] else None
        self.editor.set_language(parser.editor_language if parser else "text")
        error_line = None
        tooltip = ""
        if self._file_error:
            text, role = self._file_error, "error"
        elif trim(state["text"]) == "":
            text, role = t.input_empty, "muted"
        elif not read["format"]:
            text, role = t.undetected, "warning"
        elif outcome and not outcome["ok"]:
            error = outcome["error"]
            prefix = f"{t.error_position(error['line'], error.get('column', 1))} · " if "line" in error else ""
            text, role = prefix + t.parse_issue(error), "error"
            error_line = error.get("line")
        elif outcome:
            schema = outcome["schema"]
            text = t.input_summary(
                parser.label if parser else read["format"], len(schema["models"]), field_count(schema)
            )
            if state.get("receivedFrom"):
                text = f"{t.received_from(state['receivedFrom'])} {text}"
            warnings = outcome["warnings"]
            if warnings:
                text += f" · {t.warnings_count(len(warnings))}"
            tooltip = "\n".join(t.parse_issue(warning) for warning in warnings)
            role = "success"
        else:
            text, role = "", "muted"
        self.editor.highlight_error_line(error_line)
        self.status.setText(text)
        self.status.setToolTip(tooltip)
        self.status.setProperty("role", role)
        self.status.style().unpolish(self.status)
        self.status.style().polish(self.status)
        self._updating = False
