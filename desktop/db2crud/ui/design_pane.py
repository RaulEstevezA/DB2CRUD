"""Design pane: the CRUD design of the database, table by table, with the decisions the schema cannot settle, the
queries of each repository and the operations of each service; pending proposals are listed first and never applied
on their own. Undo, redo and reset. Mirrors web/src/components/design/DesignPane.tsx."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLayout,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..core.crud.edit import accept, decide_policy, set_operation_include, set_query_include
from .i18n import I18n
from .pane import Pane
from .session import Session
from .widgets import DecisionControl, clear_layout, confidence_badge, field_label, mono, muted, set_role, small_button

POLICY_KINDS = ("role", "delete", "concurrency", "children", "hidden")


class DesignPane(Pane):
    def __init__(self, i18n: I18n, session: Session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        # Where each decision is, so the review list can move the focus to it
        self._controls: dict[str, QWidget] = {}

        self.undo_button = QPushButton()
        self.undo_button.clicked.connect(session.undo)
        self.redo_button = QPushButton()
        self.redo_button.clicked.connect(session.redo)
        self.reset_button = QPushButton()
        self.reset_button.clicked.connect(self._reset)
        for button in (self.undo_button, self.redo_button, self.reset_button):
            self.header.addWidget(button)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.content = QWidget()
        self.content_layout = QVBoxLayout(self.content)
        self.content_layout.setContentsMargins(14, 8, 14, 14)
        self.content_layout.setSpacing(12)
        # The content keeps its own height and scrolls, instead of being squeezed into the visible area
        self.content_layout.setSizeConstraint(QLayout.SizeConstraint.SetMinAndMaxSize)
        self.scroll.setWidget(self.content)
        self.body.addWidget(self.scroll, 1)

        self.status = QLabel()
        self.status.setWordWrap(True)
        self.footer.addWidget(self.status, 1)

        i18n.changed.connect(self.refresh)
        session.design_changed.connect(self.refresh)
        self.refresh()

    def _reset(self) -> None:
        if QMessageBox.question(self, "DB2CRUD", self._i18n.t.confirm_reset) == QMessageBox.StandardButton.Yes:
            self._session.reset_design()

    def focus_decision(self, key: str) -> None:
        control = self._controls.get(key)
        if control is None:
            return
        self.scroll.ensureWidgetVisible(control)
        if isinstance(control, DecisionControl):
            control.focus_control()
        else:
            control.setFocus()

    # Display

    @staticmethod
    def _key(ref: dict) -> str:
        subject = ref["decision"] if ref["kind"] == "policy" else ref["id"]
        return f"{ref['kind']}:{ref['table']}:{subject}"

    def _subject(self, ref: dict) -> str:
        t = self._i18n.t
        if ref["kind"] == "policy":
            return t.policy_subject(ref["table"], t.policy_kinds[ref["decision"]])
        return t.item_subject(ref["table"], ref["id"].split(":")[0], ref["id"])

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        design = session.design
        self.title.setText(t.workspace_parts["design"])
        for button, text, tooltip, enabled in (
            (self.undo_button, t.undo, t.undo_title, session.can_undo),
            (self.redo_button, t.redo, t.redo_title, session.can_redo),
            (self.reset_button, t.reset, t.reset_title, design is not None),
        ):
            button.setText(text)
            button.setToolTip(tooltip)
            button.setEnabled(enabled)
        clear_layout(self.content_layout)
        self._controls = {}
        if design is None:
            self.content_layout.addWidget(muted(t.design_empty))
            self.content_layout.addStretch()
            self.status.setText("")
            return
        pending = session.pending
        if pending:
            box = QFrame()
            box.setObjectName("reviewBox")
            box_layout = QVBoxLayout(box)
            box_layout.setContentsMargins(12, 8, 12, 8)
            title = QLabel(t.pending_count(len(pending)))
            set_role(title, "warning")
            box_layout.addWidget(title)
            for ref in pending:
                link = QPushButton(self._subject(ref))
                link.setFlat(True)
                link.setProperty("link", True)
                key = self._key(ref)
                link.clicked.connect(lambda _=False, key=key: self.focus_decision(key))
                box_layout.addWidget(link, 0, Qt.AlignmentFlag.AlignLeft)
            self.content_layout.addWidget(box)
        for policy in design["policies"]:
            self.content_layout.addWidget(self._table_card(design, policy))
        self.content_layout.addStretch()
        text = t.design_summary(len(design["repositories"]), len(design["services"]))
        if pending:
            text += f" · {t.pending_count(len(pending))}"
        self.status.setText(text)
        set_role(self.status, "warning" if pending else "muted")

    def _label(self, kind: str, value) -> str:
        t = self._i18n.t
        if kind == "role":
            return t.roles[value]
        if kind == "delete":
            return t.delete_hard if value["mode"] == "hard" else t.delete_soft(value["column"])
        if kind == "concurrency":
            return t.concurrency_none if value["mode"] == "none" else t.concurrency_version(value["column"])
        if kind == "children":
            return t.children_policies[value]
        return ", ".join(value) if value else t.hidden_none

    def _table_card(self, design: dict, policy: dict) -> QFrame:
        t = self._i18n.t
        session = self._session
        table = policy["table"]
        repository = next((item for item in design["repositories"] if item["table"] == table), None)
        service = next((item for item in design["services"] if item["table"] == table), None)
        card = QFrame()
        card.setObjectName("card")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(14, 10, 14, 12)
        layout.setSpacing(8)
        header = QHBoxLayout()
        header.addWidget(mono(table, "type"))
        if repository:
            header.addWidget(muted(repository["entity"], wrap=False))
        header.addStretch()
        if repository and repository["entityMissing"]:
            entity = QLabel(t.entity_missing)
            entity.setProperty("role", "badge")
            entity.setProperty("tone", "accent")
            header.addWidget(entity)
        layout.addLayout(header)

        grid = QGridLayout()
        grid.setHorizontalSpacing(16)
        grid.setVerticalSpacing(4)
        cells = [(kind, policy[kind]) for kind in POLICY_KINDS if policy[kind] is not None]
        for index, (kind, decision) in enumerate(cells):
            row, column = divmod(index, 3)
            ref = {"kind": "policy", "table": table, "decision": kind}
            control = DecisionControl(
                t,
                t.policy_subject(table, t.policy_kinds[kind]),
                decision,
                lambda value, kind=kind: self._label(kind, value),
                lambda value, kind=kind: session.change(lambda current: decide_policy(current, table, kind, value)),
                lambda ref=ref: session.change(lambda current: accept(current, ref)),
                compact=True,
            )
            self._controls[self._key(ref)] = control
            grid.addWidget(field_label(t.policy_kinds[kind]), row * 2, column)
            grid.addWidget(control, row * 2 + 1, column)
        for column in range(3):
            grid.setColumnStretch(column, 1)
        layout.addLayout(grid)

        if repository:
            layout.addWidget(field_label(t.queries_title))
            for query in repository["queries"]:
                layout.addWidget(
                    self._item(
                        {"kind": "query", "table": table, "id": query["id"]},
                        query,
                        t.query_description(query["kind"], query["columns"]),
                        set_query_include,
                    )
                )
        if service:
            layout.addWidget(field_label(service["name"]))
            for operation in service["operations"]:
                layout.addWidget(
                    self._item(
                        {"kind": "operation", "table": table, "id": operation["id"]},
                        operation,
                        t.operation_description(operation),
                        set_operation_include,
                    )
                )
        return card

    def _item(self, ref: dict, item: dict, description: str, toggle) -> QWidget:
        """A query or an operation, on or off, with its confidence when it is not exact."""
        t = self._i18n.t
        session = self._session
        include = item["include"]
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        check = QCheckBox(item["name"])
        check.setChecked(include["value"])
        check.setAccessibleName(self._subject(ref))
        check.toggled.connect(lambda on: session.change(lambda current: toggle(current, ref["table"], ref["id"], on)))
        self._controls[self._key(ref)] = check
        layout.addWidget(check)
        layout.addWidget(muted(description), 1)
        pending = include["status"] == "pending"
        if pending or include.get("manual") or include["confidence"] != "exact":
            badge = confidence_badge(t, "manual" if include.get("manual") else include["confidence"])
            badge.setToolTip(" ".join(t.reason(reason) for reason in include["reasons"]))
            layout.addWidget(badge)
        if pending:
            confirm = small_button(t.accept)
            confirm.setToolTip(t.accept_title(item["name"]))
            confirm.clicked.connect(lambda: session.change(lambda current: accept(current, ref)))
            layout.addWidget(confirm)
        return row
