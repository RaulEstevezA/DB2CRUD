"""The database the code is generated for: editor, open, clear and the reading status. Read on this computer and never
sent anywhere. It reads Model2DB projects and ORM code (SQLAlchemy, SQLModel, Django, Tortoise, Prisma,
TypeORM, Sequelize, Drizzle, JPA, EF Core, Doctrine and Eloquent so far) and SQL DDL. Mirrors
web/src/components/database/DatabasePane.tsx, and goes further: the desktop version opens several files or a whole
folder at once, listed above the editor (the web version reads one text)."""

from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import QFileDialog, QLabel, QListWidget, QPushButton

from ..core.js import trim
from ..workspace import TooManyFiles, column_count, gather_files, input_language, source_label
from .code_view import CodeView
from .i18n import I18n
from .pane import Pane
from .session import Session

# Far above any project; avoids freezing the window with a huge file opened by mistake
MAX_FILE_SIZE = 10 * 1024 * 1024


class InputEditor(CodeView):
    """Editor that opens files dropped on it instead of inserting their path."""

    files_dropped = Signal(list)

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
        paths = [url.toLocalFile() for url in event.mimeData().urls() if url.isLocalFile()]
        if paths:
            event.acceptProposedAction()
            self.files_dropped.emit(paths)
        else:
            super().dropEvent(event)


class DatabasePane(Pane):
    def __init__(self, i18n: I18n, session: Session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        self._file_error: str | None = None
        self._updating = False

        self.open_button = QPushButton()
        self.open_button.clicked.connect(self.choose_file)
        self.folder_button = QPushButton()
        self.folder_button.clicked.connect(self.choose_folder)
        self.clear_button = QPushButton()
        self.clear_button.clicked.connect(self._clear)
        for button in (self.open_button, self.folder_button, self.clear_button):
            self.header.addWidget(button)

        # The files of the input, when it has several: the one selected is in the editor
        self.file_list = QListWidget()
        self.file_list.setMaximumHeight(140)
        self.file_list.currentRowChanged.connect(self._select_file)
        self.body.addWidget(self.file_list)

        self.editor = InputEditor("json")
        self._language = "json"
        self.editor.files_dropped.connect(self.open_paths)
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
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            t.open_dialog,
            "",
            f"{t.project_files} (*.json *.py *.prisma *.ts *.js *.java *.cs *.php *.sql);;{t.all_files} (*)",
        )
        if paths:
            self.open_paths(paths)

    def choose_folder(self) -> None:
        path = QFileDialog.getExistingDirectory(self, self._i18n.t.folder_dialog)
        if path:
            self.open_paths([path])

    def open_paths(self, paths: list[str]) -> None:
        """One file is opened as it is; several files or a folder become an input of several files."""
        if len(paths) == 1 and Path(paths[0]).is_file():
            self.open_file(paths[0])
            return
        t = self._i18n.t
        try:
            files = gather_files(paths)
        except TooManyFiles:
            self._show_file_error(t.too_many_files)
            return
        if not files:
            self._show_file_error(t.no_readable_files)
            return
        self._file_error = None
        self._session.set_input({"text": files[0]["text"], "files": files, "selected": 0})

    def _select_file(self, row: int) -> None:
        state = self._session.input
        if self._updating or row < 0 or not state.get("files") or row == state.get("selected"):
            return
        self._commit_text()
        state = self._session.input
        self._session.set_input({**state, "selected": row, "text": state["files"][row]["text"]})

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
        self._session.set_input({"text": text, "fileName": file.name})

    def set_text(self, text: str) -> None:
        self.editor.setPlainText(text)
        self._commit_text()

    def _show_file_error(self, text: str) -> None:
        self._file_error = text
        self.refresh()

    def _clear(self) -> None:
        self._file_error = None
        self._session.set_input({"text": ""})

    def _typed(self) -> None:
        if not self._updating:
            self._file_error = None
            self._timer.start()

    def _commit_text(self) -> None:
        self._timer.stop()
        text = self.editor.toPlainText()
        state = self._session.input
        if text == state["text"]:
            return
        files = state.get("files")
        if files:
            # The text edited is the selected file's
            selected = state.get("selected", 0)
            changed = [{**file, "text": text} if index == selected else file for index, file in enumerate(files)]
            self._session.set_input({**state, "text": text, "files": changed})
        else:
            self._session.set_input({"text": text})

    # Display

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        state = session.input
        read = session.read
        self._updating = True
        self.title.setText(t.workspace_parts["database"])
        self.open_button.setText(t.open_file)
        self.folder_button.setText(t.open_folder)
        self.clear_button.setText(t.clear)
        files = state.get("files") or []
        self.clear_button.setEnabled(state["text"] != "" or bool(files))
        names = [file["name"] for file in files]
        if [self.file_list.item(row).text() for row in range(self.file_list.count())] != names:
            self.file_list.clear()
            self.file_list.addItems(names)
        if files:
            self.file_list.setCurrentRow(state.get("selected", 0))
        self.file_list.setVisible(len(files) > 1)
        self.file_list.setAccessibleName(t.files_label)
        self.editor.setPlaceholderText(t.input_placeholder)
        self.editor.setAccessibleName(t.input_label)
        self.editor.setAccessibleDescription(t.editor_keys)
        # A Model2DB project is JSON; ORM code is in the language of its ORM
        language = input_language(state)
        if language != self._language:
            self._language = language
            self.editor.set_language(language)
        # Text being typed is not replaced: it reaches the session once typing pauses
        if self.editor.toPlainText() != state["text"] and not self._timer.isActive():
            self.editor.setPlainText(state["text"])

        error_line = None
        tooltip = ""
        if self._file_error:
            text, role = self._file_error, "error"
        elif trim(state["text"]) == "" or read is None:
            text, role = t.input_empty, "muted"
        elif not read["ok"]:
            text, role = t.read_error(read["error"], read.get("path")), "error"
        else:
            schema = read["schema"]
            text = t.database_summary(
                source_label(schema), schema["dialect"], len(schema["tables"]), column_count(schema)
            )
            if schema["notes"]:
                text += f" · {t.warnings_count(len(schema['notes']))}"
            tooltip = "\n".join(note["code"] for note in schema["notes"])
            role = "success"
        self.editor.highlight_error_line(error_line)
        self.status.setText(text)
        self.status.setToolTip(tooltip)
        self.status.setProperty("role", role)
        self.status.style().unpolish(self.status)
        self.status.style().polish(self.status)
        self._updating = False
