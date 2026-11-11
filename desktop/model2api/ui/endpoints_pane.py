"""Endpoints pane: the API Model2API proposes for the models, to review and change. It lists what waits for the
user and the problems that leave an endpoint out of the code, with undo, redo and reset. Mirrors
web/src/components/endpoints/ (EndpointsPane, ResourceCard, FieldTable and EndpointList).

The pane is rebuilt from the design after every change; what is open (fields, the endpoint editor) and the control
that had the focus are kept across rebuilds.
"""

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

from ..core.analysis.constraints import read_constraints
from ..core.api.types import HTTP_METHODS
from ..core.design.edit import (
    add_custom_endpoint,
    decide,
    get_decision,
    remove_endpoint,
    set_field_include,
    set_resource_path,
    update_endpoint,
)
from ..core.design.propose import default_resource_path, key_field
from ..core.js import to_number, trim
from ..core.model.schema import all_fields, describe_type, find_model
from ..core.validation.design import filterable_fields
from .pane import Pane
from .widgets import (
    CommitLine,
    DecisionControl,
    badge,
    clear_layout,
    combo,
    field_label,
    mono,
    muted,
    set_role,
    small_button,
)

ACCESS = ("default", "public", "authenticated", "roles")


def ref_key(ref: dict) -> str:
    """Identifies a decision across rebuilds of the pane, to keep the focus on it."""
    if ref["kind"] in ("expose", "key"):
        return f"{ref['kind']}:{ref['model']}"
    return f"{ref['kind']}:{ref['model']}.{ref['field']}"


def _where(ref: dict) -> str:
    return ref["model"] if ref["kind"] in ("expose", "key") else f"{ref['model']}.{ref['field']}"


class EndpointsPane(Pane):
    def __init__(self, i18n, session):
        super().__init__()
        self._i18n = i18n
        self._session = session
        # Models whose fields are shown, and the endpoint whose editor is open
        self._fields_open: set[str] = set()
        self._open: str | None = None
        # The control that keeps the focus after the pane is rebuilt (confirming removes its button)
        self._focus: str | None = None
        self.controls: dict[str, DecisionControl] = {}
        self.endpoint_rows: dict[str, QFrame] = {}

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
        content = QWidget()
        self._content = QVBoxLayout(content)
        self._content.setContentsMargins(14, 0, 14, 14)
        self._content.setSpacing(10)
        # The content grows with what it holds and scrolls, instead of being squeezed into the visible height
        self._content.setSizeConstraint(QLayout.SizeConstraint.SetMinimumSize)
        self.scroll.setWidget(content)
        self.body.addWidget(self.scroll, 1)

        self.status = QLabel()
        self.status.setWordWrap(True)
        self.footer.addWidget(self.status, 1)

        i18n.changed.connect(self.refresh)
        session.design_changed.connect(self.refresh)
        self.refresh()

    # Actions

    def _reset(self) -> None:
        if QMessageBox.question(self, "Model2API", self._i18n.t.confirm_reset) == QMessageBox.StandardButton.Yes:
            self._session.reset_design()

    def _decide(self, ref: dict, value=None, accept: bool = False) -> None:
        self._focus = ref_key(ref)
        self._session.change(lambda design: decide(design, ref) if accept else decide(design, ref, value))

    def _update_endpoint(self, model: str, endpoint_id: str, patch: dict) -> None:
        self._session.change(lambda design: update_endpoint(design, model, endpoint_id, patch))

    def _add_endpoint(self, model: str) -> None:
        def edit(design: dict) -> dict:
            result = add_custom_endpoint(design, model)
            # Opened as soon as it exists, so the user adapts it
            self._open = result["id"] or self._open
            return result["design"]

        self._session.change(edit)

    def _remove_endpoint(self, model: str, endpoint_id: str) -> None:
        self._open = None
        self._session.change(lambda design: remove_endpoint(design, model, endpoint_id))

    def _toggle_fields(self, model: str) -> None:
        self._fields_open ^= {model}
        self._focus = f"fields:{model}"
        self.refresh()

    def _toggle_editor(self, endpoint_id: str) -> None:
        self._open = None if self._open == endpoint_id else endpoint_id
        self._focus = f"edit:{endpoint_id}"
        self.refresh()

    def focus_decision(self, ref: dict) -> None:
        control = self.controls.get(ref_key(ref))
        if control:
            self.scroll.ensureWidgetVisible(control)
            control.focus_control()

    def focus_endpoint(self, endpoint_id: str) -> None:
        row = self.endpoint_rows.get(endpoint_id)
        if row:
            self.scroll.ensureWidgetVisible(row)
            row.setFocus()

    # Display

    def refresh(self) -> None:
        t = self._i18n.t
        session = self._session
        self.title.setText(t.workspace_parts["endpoints"])
        self.undo_button.setText(t.undo)
        self.undo_button.setToolTip(t.undo_title)
        self.undo_button.setEnabled(session.can_undo)
        self.redo_button.setText(t.redo)
        self.redo_button.setToolTip(t.redo_title)
        self.redo_button.setEnabled(session.can_redo)
        self.reset_button.setText(t.reset)
        self.reset_button.setToolTip(t.reset_title)
        design, schema = session.design, session.schema
        self.reset_button.setEnabled(design is not None)

        scroll = self.scroll.verticalScrollBar().value()
        clear_layout(self._content)
        self.controls = {}
        self.endpoint_rows = {}
        self._focus_widgets: dict[str, QWidget] = {}
        if not design or not schema:
            self._content.addWidget(muted(t.endpoints_empty))
            self._content.addStretch()
            self.status.setText("")
            return

        pending = session.pending
        issues = session.spec["issues"] if session.spec else []
        resources = [item for item in design["resources"] if item["expose"]["value"] == "resource"]
        embedded = [item for item in design["resources"] if item["expose"]["value"] != "resource"]
        if pending:
            self._content.addWidget(self._review_box(pending, design))
        if issues:
            self._content.addWidget(self._issues_box(issues))
        if not resources:
            self._content.addWidget(muted(t.no_resources))
        for resource in resources:
            own = [issue for issue in issues if issue["model"] == resource["model"]]
            self._content.addWidget(self._resource_card(schema, resource, own))
        if embedded:
            title = QLabel(t.embedded_section)
            title.setProperty("role", "sectionTitle")
            self._content.addWidget(title)
            self._content.addWidget(muted(t.embedded_hint))
            for resource in embedded:
                self._content.addWidget(self._resource_card(schema, resource, []))
        self._content.addStretch()

        endpoints = sum(1 for resource in resources for endpoint in resource["endpoints"] if endpoint["enabled"])
        text = t.design_summary(len(resources), endpoints)
        if pending:
            text += f" · {t.pending_count(len(pending))}"
        self.status.setText(text)
        set_role(self.status, "warning" if pending else "muted")

        self.scroll.verticalScrollBar().setValue(scroll)
        focus = self._focus
        self._focus = None
        if focus:
            control = self.controls.get(focus)
            if control:
                control.focus_control()
            elif focus in self._focus_widgets:
                self._focus_widgets[focus].setFocus()

    def _review_box(self, pending: list[dict], design: dict) -> QFrame:
        t = self._i18n.t
        box = QFrame()
        box.setObjectName("row")
        box.setProperty("category", "review")
        layout = QVBoxLayout(box)
        layout.setContentsMargins(12, 8, 12, 8)
        title = QLabel(t.pending_count(len(pending)))
        title.setProperty("role", "warning")
        layout.addWidget(title)
        for ref in pending:
            row = QHBoxLayout()
            link = QPushButton(_where(ref))
            link.setProperty("link", True)
            link.setCursor(Qt.CursorShape.PointingHandCursor)
            link.clicked.connect(lambda _=False, ref=ref: self.focus_decision(ref))
            row.addWidget(link, 0, Qt.AlignmentFlag.AlignTop)
            decision = get_decision(design, ref)
            why = " ".join(t.reason(reason) for reason in decision["reasons"]) if decision else ""
            row.addWidget(muted(why), 1)
            layout.addLayout(row)
        return box

    def _issues_box(self, issues: list[dict]) -> QFrame:
        t = self._i18n.t
        errors = [issue for issue in issues if issue["severity"] == "error"]
        warnings = [issue for issue in issues if issue["severity"] == "warning"]
        box = QFrame()
        box.setObjectName("row")
        box.setProperty("category", "review")
        layout = QVBoxLayout(box)
        layout.setContentsMargins(12, 8, 12, 8)
        title = QLabel(t.issues_summary(len(errors), len(warnings)))
        title.setProperty("role", "error" if errors else "warning")
        layout.addWidget(title)
        for issue in issues:
            row = QHBoxLayout()
            if issue.get("endpoint"):
                link = QPushButton(issue["model"])
                link.setProperty("link", True)
                link.setCursor(Qt.CursorShape.PointingHandCursor)
                link.clicked.connect(lambda _=False, endpoint=issue["endpoint"]: self.focus_endpoint(endpoint))
                row.addWidget(link, 0, Qt.AlignmentFlag.AlignTop)
            else:
                row.addWidget(mono(issue["model"]), 0, Qt.AlignmentFlag.AlignTop)
            row.addWidget(muted(t.issue(issue)), 1)
            layout.addLayout(row)
        return box

    def _decision(
        self, ref: dict, subject: str, decision: dict, option_label, compact: bool = False
    ) -> DecisionControl:
        control = DecisionControl(
            self._i18n.t,
            subject,
            decision,
            option_label,
            lambda value: self._decide(ref, value),
            lambda: self._decide(ref, accept=True),
            compact,
        )
        self.controls[ref_key(ref)] = control
        return control

    def _resource_card(self, schema: dict, resource: dict, issues: list[dict]) -> QFrame:
        t = self._i18n.t
        model = resource["model"]
        is_resource = resource["expose"]["value"] == "resource"
        card = QFrame()
        card.setObjectName("row")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(12, 10, 12, 10)
        layout.setSpacing(8)

        header = QHBoxLayout()
        title = QLabel(model)
        title.setProperty("role", "sectionTitle")
        header.addWidget(title)
        header.addStretch()
        if is_resource:
            header.addWidget(mono("/"))
            path = CommitLine(
                resource.get("path") or "",
                lambda text: self._session.change(lambda design: set_resource_path(design, model, text)),
                default_resource_path(model),
            )
            path.setAccessibleName(t.resource_path_label(model))
            path.setMinimumWidth(160)
            header.addWidget(path)
        layout.addLayout(header)

        decisions = QGridLayout()
        decisions.setHorizontalSpacing(10)
        decisions.setColumnStretch(1, 1)
        decisions.addWidget(field_label(t.expose_label), 0, 0, Qt.AlignmentFlag.AlignTop)
        decisions.addWidget(
            self._decision(
                {"kind": "expose", "model": model},
                t.expose_subject(model),
                resource["expose"],
                lambda value: t.expose_options[value],
            ),
            0,
            1,
        )
        if is_resource and resource.get("key"):
            decisions.addWidget(field_label(t.key_label), 1, 0, Qt.AlignmentFlag.AlignTop)
            decisions.addWidget(
                self._decision({"kind": "key", "model": model}, t.key_subject(model), resource["key"], t.key_option),
                1,
                1,
            )
        layout.addLayout(decisions)

        included = sum(1 for field in resource["fields"] if field["include"])
        fields_row = QHBoxLayout()
        opened = model in self._fields_open
        toggle = small_button(t.hide_fields if opened else t.show_fields)
        toggle.setCheckable(True)
        toggle.setChecked(opened)
        toggle.setProperty("toggle", True)
        toggle.clicked.connect(lambda _=False: self._toggle_fields(model))
        self._focus_widgets[f"fields:{model}"] = toggle
        fields_row.addWidget(toggle)
        fields_row.addWidget(muted(t.fields_summary(len(resource["fields"]), included)), 1)
        layout.addLayout(fields_row)
        if opened:
            layout.addWidget(self._field_table(schema, resource))

        if is_resource:
            enabled = sum(1 for endpoint in resource["endpoints"] if endpoint["enabled"])
            layout.addWidget(field_label(t.endpoints_count(enabled, len(resource["endpoints"]))))
            filterable = filterable_fields(resource, schema)
            for endpoint in resource["endpoints"]:
                own = [issue for issue in issues if issue.get("endpoint") == endpoint["id"]]
                layout.addWidget(self._endpoint_row(model, endpoint, own, filterable))
            add = small_button(t.add_endpoint)
            add.clicked.connect(lambda _=False: self._add_endpoint(model))
            layout.addWidget(add, 0, Qt.AlignmentFlag.AlignLeft)
        return card

    def _field_table(self, schema: dict, resource: dict) -> QWidget:
        t = self._i18n.t
        model_name = resource["model"]
        table = QWidget()
        grid = QGridLayout(table)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(6)
        for column, text in enumerate(("", t.field_name, t.field_access, t.field_travels, t.field_validations)):
            grid.addWidget(field_label(text), 0, column)
        grid.setColumnStretch(2, 1)
        grid.setColumnStretch(3, 1)
        model = find_model(schema, model_name)
        definitions = {field["name"]: field for field in all_fields(schema, model)} if model else {}
        key = key_field(resource)
        for row, field in enumerate(resource["fields"], start=1):
            name = field["field"]
            definition = definitions.get(name)
            is_key = name == key
            subject = f"{model_name}.{name}"

            include = QCheckBox()
            include.setChecked(field["include"])
            include.setEnabled(not is_key)
            include.setAccessibleName(t.include_field(name))
            include.setToolTip(t.key_always_included if is_key else t.include_field(name))
            include.toggled.connect(
                lambda checked, name=name: self._session.change(
                    lambda design: set_field_include(design, model_name, name, checked)
                )
            )
            grid.addWidget(include, row, 0, Qt.AlignmentFlag.AlignTop)

            names = QHBoxLayout()
            names.setSpacing(6)
            names.addWidget(mono(name, "name"))
            if is_key:
                names.addWidget(badge(t.key_badge, "accent"))
            if definition:
                names.addWidget(mono(definition.get("originalType") or describe_type(definition["type"]), "type"))
            names.addStretch()
            grid.addLayout(names, row, 1, Qt.AlignmentFlag.AlignTop)

            grid.addWidget(
                self._decision(
                    {"kind": "access", "model": model_name, "field": name},
                    t.access_subject(subject),
                    field["access"],
                    lambda value: t.access_options[value],
                    compact=True,
                ),
                row,
                2,
                Qt.AlignmentFlag.AlignTop,
            )

            travels = QVBoxLayout()
            if field.get("relation"):
                travels.addWidget(
                    self._decision(
                        {"kind": "relation", "model": model_name, "field": name},
                        t.relation_subject(subject),
                        field["relation"],
                        lambda value: t.relation_options[value],
                        compact=True,
                    )
                )
            if field.get("unknownType"):
                travels.addWidget(
                    self._decision(
                        {"kind": "unknownType", "model": model_name, "field": name},
                        t.unknown_type_subject(subject),
                        field["unknownType"],
                        lambda value: t.unknown_type_options[value],
                        compact=True,
                    )
                )
            if not field.get("relation") and not field.get("unknownType"):
                travels.addWidget(muted(t.travels_as_value))
            grid.addLayout(travels, row, 3, Qt.AlignmentFlag.AlignTop)

            language = (schema.get("origin") or {}).get("language")
            constraints = read_constraints(definition, language) if definition else None
            if constraints and constraints["sources"]:
                validations = muted(t.describe_constraints(constraints["constraints"]))
                validations.setToolTip("\n".join(constraints["sources"]))
            else:
                validations = muted("—")
            grid.addWidget(validations, row, 4, Qt.AlignmentFlag.AlignTop)
        return table

    def _endpoint_row(self, model: str, endpoint: dict, issues: list[dict], filterable: list[str]) -> QFrame:
        t = self._i18n.t
        endpoint_id = endpoint["id"]
        row = QFrame()
        row.setObjectName("row")
        row.setFocusPolicy(Qt.FocusPolicy.ClickFocus)
        if not endpoint["enabled"]:
            row.setProperty("off", True)
        expanded = self._open == endpoint_id
        if expanded:
            row.setProperty("open", True)
        self.endpoint_rows[endpoint_id] = row
        layout = QVBoxLayout(row)
        layout.setContentsMargins(10, 6, 10, 6)
        layout.setSpacing(6)

        line = QHBoxLayout()
        line.setSpacing(8)
        enabled = QCheckBox()
        enabled.setChecked(endpoint["enabled"])
        enabled.setAccessibleName(t.enable_endpoint(f"{endpoint['method']} {endpoint['path']}"))
        enabled.setToolTip(t.enable_endpoint(f"{endpoint['method']} {endpoint['path']}"))
        enabled.toggled.connect(lambda checked: self._update_endpoint(model, endpoint_id, {"enabled": checked}))
        line.addWidget(enabled)
        method = QLabel(endpoint["method"])
        method.setProperty("role", "method")
        method.setMinimumWidth(56)
        line.addWidget(method)
        line.addWidget(mono(endpoint["path"]))
        line.addWidget(muted(endpoint["summary"], wrap=False), 1)
        if endpoint["operation"] == "custom":
            line.addWidget(badge(t.custom_badge))
        if not endpoint["enabled"]:
            line.addWidget(badge(t.endpoint_off))
        errors = [issue for issue in issues if issue["severity"] == "error"]
        if errors:
            blocked = badge(t.not_generated, "danger")
            blocked.setToolTip("\n".join(t.issue(issue) for issue in errors))
            line.addWidget(blocked)
        edit = small_button(t.done if expanded else t.edit)
        edit.clicked.connect(lambda _=False: self._toggle_editor(endpoint_id))
        self._focus_widgets[f"edit:{endpoint_id}"] = edit
        line.addWidget(edit)
        layout.addLayout(line)

        for issue in issues:
            text = QLabel(t.issue(issue))
            text.setWordWrap(True)
            text.setProperty("role", "error" if issue["severity"] == "error" else "warning")
            layout.addWidget(text)
        if expanded:
            layout.addWidget(self._endpoint_editor(model, endpoint, filterable))
        return row

    def _endpoint_editor(self, model: str, endpoint: dict, filterable: list[str]) -> QWidget:
        """The settings of one endpoint. Every change applies at once and can be undone."""
        t = self._i18n.t
        endpoint_id = endpoint["id"]
        custom = endpoint["operation"] == "custom"
        auth = self._session.settings["auth"]

        def change(patch: dict) -> None:
            self._focus = f"edit:{endpoint_id}"
            self._update_endpoint(model, endpoint_id, patch)

        editor = QWidget()
        layout = QVBoxLayout(editor)
        layout.setContentsMargins(0, 4, 0, 0)
        layout.setSpacing(8)
        grid = QGridLayout()
        grid.setHorizontalSpacing(10)
        grid.setVerticalSpacing(4)
        grid.setColumnStretch(1, 1)
        cells: list[tuple[str, QWidget]] = []
        if custom:
            cells.append(
                (
                    t.method_label,
                    combo(
                        [(method, method) for method in HTTP_METHODS],
                        endpoint["method"],
                        lambda value: change({"method": value}),
                    ),
                )
            )
        cells.append((t.path_label, CommitLine(endpoint["path"], lambda text: change({"path": text}))))
        cells.append((t.name_label, CommitLine(endpoint["name"], lambda text: change({"name": trim(text)}))))
        cells.append(
            (
                t.summary_label,
                CommitLine(endpoint["summary"], lambda text: change({"summary": trim(text) or endpoint["summary"]})),
            )
        )
        cells.append(
            (
                t.access_label,
                combo(
                    [(t.endpoint_access[access], access) for access in ACCESS],
                    endpoint["access"],
                    lambda value: change({"access": value}),
                ),
            )
        )
        if endpoint["access"] == "roles":
            cells.append(
                (
                    t.roles_label,
                    CommitLine(", ".join(endpoint["roles"]), lambda text: change({"roles": text.split(",")})),
                )
            )

        def status(text: str) -> None:
            if trim(text) == "":
                change({"status": None})
                return
            value = to_number(text)
            if value is not None:
                change({"status": value})

        status_value = "" if endpoint.get("status") is None else str(endpoint["status"])
        cells.append((t.status_label, CommitLine(status_value, status, t.status_default)))
        if custom:
            cells.append(
                (
                    t.input_body_label,
                    combo(
                        [(t.custom_input[value], value) for value in ("none", "resource", "partial")],
                        endpoint.get("input") or "none",
                        lambda value: change({"input": value}),
                    ),
                )
            )
            cells.append(
                (
                    t.output_label,
                    combo(
                        [(t.custom_output[value], value) for value in ("none", "resource", "list")],
                        endpoint.get("output") or "resource",
                        lambda value: change({"output": value}),
                    ),
                )
            )
        for index, (label, widget) in enumerate(cells):
            text = field_label(label)
            text.setBuddy(widget)
            widget.setAccessibleName(label)
            grid.addWidget(text, index, 0)
            grid.addWidget(widget, index, 1)
        layout.addLayout(grid)

        if endpoint["operation"] == "list":
            pages = QCheckBox(t.pagination_label)
            pages.setChecked(endpoint.get("pagination") is True)
            pages.toggled.connect(lambda checked: change({"pagination": checked}))
            layout.addWidget(pages)
            if filterable:
                for label, key in ((t.filters_label, "filters"), (t.sort_label, "sort")):
                    layout.addLayout(self._chips(label, filterable, endpoint.get(key) or [], key, change))
        if auth == "none" and endpoint["access"] not in ("default", "public"):
            layout.addWidget(muted(t.access_needs_auth))
        if custom:
            footer = QHBoxLayout()
            footer.addWidget(muted(t.custom_note), 1)
            remove = small_button(t.remove_endpoint)
            remove.clicked.connect(lambda _=False: self._remove_endpoint(model, endpoint_id))
            footer.addWidget(remove, 0, Qt.AlignmentFlag.AlignTop)
            layout.addLayout(footer)
        return editor

    @staticmethod
    def _chips(label: str, fields: list[str], chosen: list[str], key: str, change) -> QHBoxLayout:
        """Selectable chips: one per field that can be filtered or sorted by."""
        row = QHBoxLayout()
        row.setSpacing(6)
        title = field_label(label)
        title.setMinimumWidth(80)
        row.addWidget(title)
        for field in fields:
            chip = QPushButton(field)
            chip.setProperty("chip", True)
            chip.setCheckable(True)
            chip.setChecked(field in chosen)
            chip.setAccessibleName(f"{label}: {field}")

            def toggle(_=False, field=field) -> None:
                change({key: [item for item in chosen if item != field] if field in chosen else [*chosen, field]})

            chip.clicked.connect(toggle)
            row.addWidget(chip)
        row.addStretch()
        return row
