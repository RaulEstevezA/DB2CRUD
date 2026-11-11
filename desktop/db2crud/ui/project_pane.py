"""Project pane: every setting of the generated project, whether the stack is verified, the tree of generated files
with a viewer, and the ways to take them: copy, save one file or the whole project as a .zip. Everything is written
on this computer. Mirrors web/src/components/project/ProjectPane.tsx and FileTree.tsx.
"""

import re
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QSplitter,
    QTreeWidget,
    QTreeWidgetItem,
)

from ..core.export.zip import create_zip
from ..core.settings.settings import STACKS, find_stack
from ..core.settings.verified import is_verified
from .code_view import CodeView
from .pane import Pane, section
from .paths import in_downloads
from .widgets import CommitLine, clear_layout, combo, field_label, muted, set_role

_TODO = re.compile(r"\bTODO\b")
_PATH_ROLE = Qt.ItemDataRole.UserRole
# Settings per row of the form
COLUMNS = 6

_BY_EXTENSION = {
    "py": "python",
    "ts": "typescript",
    "js": "javascript",
    "mjs": "javascript",
    "java": "java",
    "kt": "kotlin",
    "kts": "kotlin",
    "cs": "csharp",
    "php": "php",
    "rs": "rust",
    "swift": "swift",
    "json": "json",
    "yaml": "yaml",
    "yml": "yaml",
    "xml": "xml",
    "md": "markdown",
    "toml": "toml",
    "prisma": "prisma",
}


def language_of_file(path: str) -> str:
    """The highlighting of a generated file, by its name. Mirrors languageOfFile in editorLanguages.ts."""
    name = path.split("/")[-1]
    if name == ".env.example" or name.endswith(".properties"):
        return "properties"
    extension = name[name.rfind(".") + 1 :].lower() if "." in name else ""
    return _BY_EXTENSION.get(extension, "text")


def build_tree(files: list[dict]) -> dict:
    """Folders and files as nested {"folders": {name: folder}, "files": [file]}."""
    root: dict = {"folders": {}, "files": []}
    for file in files:
        folder = root
        for part in file["path"].split("/")[:-1]:
            folder = folder["folders"].setdefault(part, {"folders": {}, "files": []})
        folder["files"].append(file)
    return root


class ProjectPane(Pane):
    def __init__(self, i18n, session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        self._chosen: str | None = None
        self._tree_key: tuple = ()
        self._form_key: tuple = ()
        # Last saved path, for the tests and the message
        self.last_saved: str | None = None

        self._copied = QTimer(self)
        self._copied.setSingleShot(True)
        self._copied.setInterval(2000)
        self._copied.timeout.connect(self.refresh)

        settings = section()
        self._grid = QGridLayout(settings)
        self._grid.setContentsMargins(14, 0, 14, 10)
        self._grid.setHorizontalSpacing(12)
        self._grid.setVerticalSpacing(4)
        # The form keeps the height of its rows; the file browser takes the rest
        settings.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        self.body.addWidget(settings)

        self.verified = QLabel()
        self.verified.setWordWrap(True)
        verified_holder = section()
        verified_layout = QHBoxLayout(verified_holder)
        verified_layout.setContentsMargins(14, 0, 14, 8)
        verified_layout.addWidget(self.verified)
        self.body.addWidget(verified_holder)

        self.empty = muted("")
        empty_holder = section()
        empty_layout = QHBoxLayout(empty_holder)
        empty_layout.setContentsMargins(14, 4, 14, 14)
        empty_layout.addWidget(self.empty)
        self._empty_holder = empty_holder
        self.body.addWidget(empty_holder)

        self.tree = QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.currentItemChanged.connect(self._choose)
        self.code = CodeView("text", read_only=True)
        self.browser = QSplitter(Qt.Orientation.Horizontal)
        self.browser.addWidget(self.tree)
        self.browser.addWidget(self.code)
        self.browser.setChildrenCollapsible(False)
        self.browser.setSizes([280, 900])
        self.body.addWidget(self.browser, 1)

        self.file_label = QLabel()
        self.file_label.setWordWrap(True)
        self.footer.addWidget(self.file_label, 1)
        self.copy_button = QPushButton()
        self.copy_button.clicked.connect(self.copy_file)
        self.save_file_button = QPushButton()
        self.save_file_button.clicked.connect(lambda: self.save_file())
        self.zip_button = QPushButton()
        self.zip_button.setProperty("primary", True)
        self.zip_button.clicked.connect(lambda: self.save_zip())
        for button in (self.copy_button, self.save_file_button, self.zip_button):
            self.footer.addWidget(button)

        i18n.changed.connect(self._retranslate)
        session.output_changed.connect(self.refresh)
        self._retranslate()

    # Actions

    @property
    def file(self) -> dict | None:
        """The chosen file while it exists; the README otherwise, so the pane always shows something useful."""
        files = self._session.files
        return (
            next((item for item in files if item["path"] == self._chosen), None)
            or next((item for item in files if item["path"] == "README.md"), None)
            or (files[0] if files else None)
        )

    def select(self, path: str) -> None:
        self._chosen = path
        self.refresh()

    def _choose(self, item: QTreeWidgetItem | None, _previous=None) -> None:
        path = item.data(0, _PATH_ROLE) if item else None
        if path and path != self._chosen:
            self._chosen = path
            self.refresh()

    def copy_file(self) -> None:
        file = self.file
        if file:
            QApplication.clipboard().setText(file["content"])
            self.copy_button.setText(self._i18n.t.copied)
            self._copied.start()

    def _save_text(self, file: dict, path: str | None) -> None:
        name = file["path"].split("/")[-1]
        target = path or QFileDialog.getSaveFileName(self, self._i18n.t.save_file, in_downloads(name))[0]
        if target:
            Path(target).write_text(file["content"], encoding="utf-8")
            self._saved(target)

    def save_file(self, path: str | None = None) -> None:
        file = self.file
        if file:
            self._save_text(file, path)

    def save_zip(self, path: str | None = None) -> None:
        files = self._session.files
        if not files:
            return
        settings = self._session.settings
        name = f"{settings['name']}.zip"
        target = path or QFileDialog.getSaveFileName(self, self._i18n.t.save_file, in_downloads(name), "ZIP (*.zip)")[0]
        if target:
            archive = create_zip(
                [{"name": f"{settings['name']}/{item['path']}", "content": item["content"]} for item in files]
            )
            Path(target).write_bytes(archive)
            self._saved(target)

    def _saved(self, target: str) -> None:
        self.last_saved = target
        self.file_label.setText(self._i18n.t.saved(Path(target).name))

    def _set(self, **change) -> None:
        self._session.set_settings(**change)

    # Display

    def _retranslate(self) -> None:
        self._tree_key = ()
        self.refresh()

    def _settings_form(self) -> None:
        t = self._i18n.t
        settings = self._session.settings
        key = (self._i18n.language, tuple(sorted((name, str(value)) for name, value in settings.items())))
        if key == self._form_key:
            return
        self._form_key = key
        # The setting being changed keeps the focus after the form is rebuilt
        focused = QApplication.focusWidget()
        focused_name = focused.accessibleName() if focused and self.isAncestorOf(focused) else None
        stack = find_stack(settings["language"], settings["orm"]) or STACKS[0]
        clear_layout(self._grid)
        yes_no = [(t.yes, True), (t.no, False)]

        def choice(key: str, label: str, items: list[tuple[str, object]]) -> None:
            cells.append((label, combo(items, settings[key], lambda value, key=key: self._set(**{key: value}))))

        cells = [(t.project_name, CommitLine(settings["name"], lambda text: self._set(name=text)))]
        stacks = combo(
            [
                (f"{t.languages[item['language']]} · {item['label']}", f"{item['language']}:{item['orm']}")
                for item in STACKS
            ],
            f"{settings['language']}:{settings['orm']}",
            lambda value: self._set(**dict(zip(("language", "orm"), value.split(":"), strict=True))),
        )
        cells.append((t.stack_label, stacks))
        choice("database", t.database_label, [(t.databases[item], item) for item in stack["databases"]])
        choice("execution", t.execution_label, [(t.executions[item], item) for item in stack["execution"]])
        choice("entities", t.entities_label, [(t.entities_modes[item], item) for item in ("missing", "all", "none")])
        if settings["entities"] != "all":
            module = CommitLine(settings["entitiesModule"], lambda text: self._set(entitiesModule=text))
            cells.append((t.entities_module_label, module))
        choice("services", t.services_label, yes_no)
        if settings["services"]:
            choice(
                "serviceTypes", t.service_types_label, [(t.service_types[item], item) for item in ("entities", "dtos")]
            )
            if settings["serviceTypes"] == "dtos":
                choice("dtoKind", t.dto_kind_label, [(t.dto_kinds[item], item) for item in stack["dtoKinds"]])
        choice(
            "transactions",
            t.transactions_label,
            [(t.transactions[item], item) for item in ("operation", "caller", "repository")],
        )
        if len(stack["errors"]) > 1:
            choice("errors", t.errors_label, [(t.error_styles[item], item) for item in stack["errors"]])
        choice("paging", t.paging_label, [(t.pagings[item], item) for item in ("offset", "cursor", "none")])
        choice("architecture", t.architecture_label, [(t.architectures[item], item) for item in ("layer", "table")])
        choice("verbs", t.verbs_label, [(t.verbs[item], item) for item in ("getFind", "get", "find")])
        choice("repositoryInterfaces", t.interfaces_label, yes_no)
        choice("memoryRepositories", t.memory_label, yes_no)
        tests = ("all", "services", "repositories", "none") if settings["services"] else ("repositories", "none")
        choice("tests", t.tests_label, [(t.tests_modes[item], item) for item in tests])
        # Six settings per row, each with its label above, so every setting fits in a few rows
        for index, (label, widget) in enumerate(cells):
            row, column = divmod(index, COLUMNS)
            text = field_label(label)
            text.setBuddy(widget)
            widget.setAccessibleName(label)
            self._grid.addWidget(text, row * 2, column)
            self._grid.addWidget(widget, row * 2 + 1, column)
        for column in range(COLUMNS):
            self._grid.setColumnStretch(column, 1)
        for label, widget in cells:
            if label == focused_name:
                widget.setFocus()

    def _fill_tree(self, files: list[dict]) -> None:
        key = tuple(item["path"] for item in files)
        if key == self._tree_key:
            return
        self._tree_key = key
        self.tree.blockSignals(True)
        self.tree.clear()
        self.tree.setAccessibleName(self._i18n.t.file_tree_label)

        def add(parent, folder: dict) -> None:
            for name in sorted(folder["folders"], key=str.lower):
                node = QTreeWidgetItem(parent, [f"{name}/"])
                add(node, folder["folders"][name])
                node.setExpanded(True)
            for file in sorted(folder["files"], key=lambda item: item["path"].lower()):
                leaf = QTreeWidgetItem(parent, [file["path"].split("/")[-1]])
                leaf.setData(0, _PATH_ROLE, file["path"])
                leaf.setToolTip(0, file["path"])

        add(self.tree.invisibleRootItem(), build_tree(files))
        self.tree.blockSignals(False)

    def _select_in_tree(self, path: str) -> None:
        iterator = [self.tree.topLevelItem(i) for i in range(self.tree.topLevelItemCount())]
        while iterator:
            item = iterator.pop()
            if item.data(0, _PATH_ROLE) == path:
                if self.tree.currentItem() is not item:
                    self.tree.blockSignals(True)
                    self.tree.setCurrentItem(item)
                    self.tree.blockSignals(False)
                return
            iterator.extend(item.child(i) for i in range(item.childCount()))

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        self.title.setText(t.workspace_parts["project"])
        self._settings_form()
        files = session.files
        file = self.file
        showing = bool(files)
        self.browser.setVisible(showing)
        self._empty_holder.setVisible(not showing)
        self.empty.setText(t.project_empty)
        verified = is_verified(session.settings)
        self.verified.setText(t.stack_verified if verified else t.stack_not_verified)
        set_role(self.verified, "success" if verified else "warning")
        if showing:
            self._fill_tree(files)
            if file:
                self._select_in_tree(file["path"])
                self.code.set_language(language_of_file(file["path"]))
                self.code.set_text_keeping_position(file["content"])
                self.code.setAccessibleName(t.file_label(file["path"]))
        else:
            self._tree_key = ()
            self.tree.clear()
            self.code.setPlainText("")

        todos = sum(len(_TODO.findall(item["content"])) for item in files)
        text = file["path"] if file else t.project_empty
        if files and todos > 0:
            text += f" · {t.todo_count(todos)}"
        self.file_label.setText(text)
        set_role(self.file_label, "mono" if file else "muted")
        if not self._copied.isActive():
            self.copy_button.setText(t.copy)
        self.copy_button.setEnabled(file is not None)
        self.save_file_button.setText(t.save_file)
        self.save_file_button.setEnabled(file is not None)
        self.zip_button.setText(t.save_zip(len(files)))
        self.zip_button.setEnabled(bool(files))
