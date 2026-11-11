"""Small widgets shared by the panes: badges with a state as text (never color alone), the decision control, a
text field that applies its value when the user is done, and helpers. Mirrors web/src/components/common/."""

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLayout,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..core.api.types import same_value

_TONES = {
    "exact": "success",
    "high": "success",
    "probable": "accent",
    "review": "warning",
    "conflict": "warning",
    "none": "",
    "manual": "accent",
}


def badge(text: str, tone: str = "") -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "badge")
    if tone:
        label.setProperty("tone", tone)
    return label


def confidence_badge(t, confidence: str) -> QLabel:
    """State of a decision as text with a color (patterns/confidence-states.md); manual when the user chose it."""
    return badge(t.status[confidence], _TONES.get(confidence, ""))


def small_button(text: str, primary: bool = False) -> QPushButton:
    button = QPushButton(text)
    button.setProperty("small", True)
    if primary:
        button.setProperty("primary", True)
    return button


def muted(text: str, wrap: bool = True) -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "muted")
    label.setWordWrap(wrap)
    return label


def mono(text: str, tone: str = "") -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "mono")
    if tone:
        label.setProperty("tone", tone)
    return label


def field_label(text: str) -> QLabel:
    label = QLabel(text)
    label.setProperty("role", "fieldLabel")
    return label


def combo(items: list[tuple[str, object]], current=None, on_choose=None) -> QComboBox:
    """A list of (text, value); on_choose receives the value the user picks."""
    widget = QComboBox()
    for text, data in items:
        widget.addItem(text, data)
    index = next((i for i, (_text, data) in enumerate(items) if data == current), 0)
    widget.setCurrentIndex(index)
    if on_choose:
        widget.activated.connect(lambda i: on_choose(items[i][1]))
    return widget


def set_role(label: QLabel, role: str) -> None:
    """Changes the role of a label and applies its style at once."""
    label.setProperty("role", role)
    label.style().unpolish(label)
    label.style().polish(label)


def clear_layout(layout: QLayout) -> None:
    """Removes and deletes every item of a layout, nested layouts included."""
    while layout.count():
        item = layout.takeAt(0)
        widget: QWidget | None = item.widget()
        if widget is not None:
            # Hidden now and deleted by Qt later, while it still has its parent
            widget.hide()
            widget.deleteLater()
        elif item.layout() is not None:
            clear_layout(item.layout())


class CommitLine(QLineEdit):
    """A text field whose value is applied when the user leaves it or presses Enter, not on every keystroke, so a
    word typed is one step of the undo history. Escape puts the applied value back. Mirrors CommitInput.tsx."""

    def __init__(self, value: str, on_commit, placeholder: str = "", mono_font: bool = False):
        super().__init__(value)
        self.setPlaceholderText(placeholder)
        if mono_font:
            self.setProperty("mono", True)
        self._value = value
        self._on_commit = on_commit
        self.editingFinished.connect(self._commit)

    def _commit(self) -> None:
        if self.text() != self._value:
            self._value = self.text()
            self._on_commit(self.text())

    def keyPressEvent(self, event) -> None:  # noqa: N802 (Qt's name)
        if event.key() == Qt.Key.Key_Escape:
            self.setText(self._value)
            return
        super().keyPressEvent(event)


class DecisionControl(QFrame):
    """One decision: the chosen or suggested option, its state in text and color, and why it was proposed. A
    pending decision offers to confirm the suggestion as it is, or to choose another option. Compact rows keep
    the reason in the tooltip. Mirrors DecisionControl.tsx."""

    def __init__(self, t, subject: str, decision: dict, option_label, on_choose, on_accept, compact: bool = False):
        super().__init__()
        self.setObjectName("decision")
        pending = decision["status"] == "pending"
        self.setAccessibleName(subject)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        row = QHBoxLayout()
        row.setSpacing(6)
        why = (
            t.reason({"code": "manual"})
            if decision.get("manual")
            else " ".join(t.reason(reason) for reason in decision["reasons"])
        )
        self.select: QComboBox | None = None
        if len(decision["options"]) > 1:
            self.select = QComboBox()
            self.select.setAccessibleName(subject)
            for option in decision["options"]:
                self.select.addItem(option_label(option))
            index = next(
                (i for i, option in enumerate(decision["options"]) if same_value(option, decision["value"])), 0
            )
            self.select.setCurrentIndex(index)
            self.select.activated.connect(lambda i: on_choose(decision["options"][i]))
            if compact:
                self.select.setToolTip(why)
            row.addWidget(self.select, 1)
        else:
            value = QLabel(option_label(decision["value"]))
            if compact:
                value.setToolTip(why)
            row.addWidget(value, 1)
        if not compact or pending or decision.get("manual"):
            state = confidence_badge(t, "manual" if decision.get("manual") else decision["confidence"])
            state.setToolTip(why)
            row.addWidget(state)
        self.accept: QPushButton | None = None
        if pending:
            self.accept = small_button(t.accept)
            self.accept.setToolTip(t.accept_title(subject))
            self.accept.setAccessibleName(t.accept_title(subject))
            self.accept.clicked.connect(on_accept)
            row.addWidget(self.accept)
        layout.addLayout(row)
        if not compact:
            layout.addWidget(muted(why))

    def focus_control(self) -> None:
        """The control itself, so its name and state are read; the decision when it has a single option."""
        (self.select or self.accept or self).setFocus()
