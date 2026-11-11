"""The window, without opening it (QT_QPA_PLATFORM=offscreen): examples, decisions, undo, endpoints, settings,
saving the project files, projects and the work kept on this computer."""

import json
import zipfile

from PySide6.QtWidgets import QApplication, QLabel

from model2api.core.compatibility.stack import FRAMEWORKS
from model2api.examples import EXAMPLES
from model2api.ui.i18n import EN, ES

NOTE = "export interface Note { title: string; body: string }"


def first_resource(session) -> dict:
    """The first model with endpoints of its own."""
    return next(item for item in session.design["resources"] if item["expose"]["value"] == "resource")


def test_both_languages_have_the_same_texts():
    assert sorted(vars(EN)) == sorted(vars(ES))


def test_every_example_gives_endpoints_and_a_project(window):
    for example in EXAMPLES:
        window.load_example(example["id"])
        session = window.session
        assert session.design is not None, example["id"]
        assert session.settings["name"] == example["project"]
        assert session.files, example["id"]
        assert window.project_pane.file_label.text().startswith("README.md")
        assert window.project_pane.code.toPlainText() == next(
            file["content"] for file in session.files if file["path"] == "README.md"
        )


def test_every_framework_writes_its_project(window):
    window.load_example("store")
    for framework in FRAMEWORKS:
        window.session.set_settings(framework=framework["id"])
        assert window.session.settings["framework"] == framework["id"]
        assert any(file["path"] == "openapi.yaml" for file in window.session.files), framework["id"]
        assert f"({len(window.session.files)} files)" in window.project_pane.zip_button.text()


def test_typing_reads_the_models_after_a_pause(window):
    pane = window.models_pane
    pane.editor.setPlainText('{"id": 1, "name": "Ana"}')
    pane._commit_text()
    assert window.session.read["format"] == "json"
    assert "2 fields" in pane.status.text()


def test_a_syntax_error_is_shown_with_its_position(window):
    window.models_pane.set_text('{"id": 1,}')
    assert window.session.read["outcome"]["ok"] is False
    assert "Line 1" in window.models_pane.status.text()


def test_confirming_a_decision_keeps_the_focus_on_it(window):
    window.models_pane.set_text(NOTE)
    session = window.session
    pane = window.endpoints_pane
    assert session.pending == [{"kind": "key", "model": "Note"}]
    assert "1 item to review" in pane.status.text()
    control = pane.controls["key:Note"]
    assert control.accept is not None
    control.accept.click()
    QApplication.processEvents()
    assert session.pending == []
    assert QApplication.focusWidget() is pane.controls["key:Note"].select


def test_undo_and_redo_a_choice(window):
    window.models_pane.set_text(NOTE)
    session = window.session
    window.endpoints_pane.controls["key:Note"].accept.click()
    assert session.can_undo and not session.pending
    window.endpoints_pane.undo_button.click()
    assert session.pending and session.can_redo
    window.endpoints_pane.redo_button.click()
    assert not session.pending


def test_changing_the_models_keeps_the_decisions(window):
    window.models_pane.set_text(NOTE)
    window.endpoints_pane.controls["key:Note"].accept.click()
    window.models_pane.set_text(NOTE.replace("body: string", "body: string; pinned: boolean"))
    assert window.session.pending == []


def test_a_business_endpoint_is_added_opened_and_removed(window):
    window.load_example("store")
    pane = window.endpoints_pane
    model = first_resource(window.session)["model"]
    before = len(first_resource(window.session)["endpoints"])
    pane._add_endpoint(model)
    endpoints = first_resource(window.session)["endpoints"]
    assert len(endpoints) == before + 1
    added = endpoints[-1]
    assert pane._open == added["id"]
    assert any("TODO" in file["content"] for file in window.session.files)
    pane._remove_endpoint(model, added["id"])
    assert len(first_resource(window.session)["endpoints"]) == before


def test_turning_an_endpoint_off_leaves_it_out(window):
    window.load_example("store")
    resource = first_resource(window.session)
    endpoint = resource["endpoints"][0]
    window.endpoints_pane._update_endpoint(resource["model"], endpoint["id"], {"enabled": False})
    assert first_resource(window.session)["endpoints"][0]["enabled"] is False
    row = window.endpoints_pane.endpoint_rows[endpoint["id"]]
    assert "off" in [label.text() for label in row.findChildren(QLabel)]


def test_saving_a_file_the_contract_and_the_zip(window, tmp_path):
    window.load_example("library")
    pane = window.project_pane
    pane.save_file(str(tmp_path / "README.md"))
    assert (tmp_path / "README.md").read_text(encoding="utf-8").startswith("# ")
    pane.save_open_api(str(tmp_path / "openapi.yaml"))
    assert (tmp_path / "openapi.yaml").read_text(encoding="utf-8").startswith("openapi: 3.1")
    pane.save_zip(str(tmp_path / "project.zip"))
    with zipfile.ZipFile(tmp_path / "project.zip") as archive:
        names = archive.namelist()
    assert len(names) == len(window.session.files)
    assert all(name.startswith("library-api/") for name in names)
    assert "Saved to" in window.project_bar.message.text()


def test_choosing_a_file_shows_it(window):
    window.load_example("store")
    window.project_pane.select("openapi.yaml")
    assert window.project_pane.code.toPlainText().startswith("openapi: 3.1")
    assert window.project_pane.file_label.text().startswith("openapi.yaml")


def test_a_project_is_saved_and_opened_again(window, tmp_path):
    window.models_pane.set_text(NOTE)
    window.endpoints_pane.controls["key:Note"].accept.click()
    window.session.set_settings(framework="express", name="notes")
    target = tmp_path / "notes.model2api.json"
    window.project_bar.save_project(str(target))
    saved = json.loads(target.read_text(encoding="utf-8"))
    assert saved["format"] == "model2api-project"
    window.load_example("store")
    window.project_bar.open_project(str(target))
    session = window.session
    assert session.input["text"] == NOTE
    assert session.settings["framework"] == "express"
    assert session.pending == []
    assert "opened" in window.project_bar.message.text()


def test_a_file_that_is_not_a_project_is_reported(window, tmp_path):
    target = tmp_path / "other.json"
    target.write_text("[1, 2]", encoding="utf-8")
    window.project_bar.open_project(str(target))
    assert "not a Model2API project" in window.project_bar.message.text()


def test_the_work_is_kept_only_when_asked(window):
    window.load_example("catalog")
    session = window.session
    assert not session.has_saved()
    window.project_bar.remember.setChecked(True)
    assert session.has_saved()
    window.session.set_input({"text": "", "format": None})
    assert session.restore_saved()
    assert session.settings["name"] == "catalog-api"
    window.project_bar.remember.setChecked(False)
    assert not session.has_saved()


def test_the_language_changes_every_pane(window):
    window.load_example("store")
    window._i18n.set_language("es")
    assert window.endpoints_pane.title.text() == "Endpoints"
    assert window.project_pane.title.text() == "Proyecto"
    assert "recursos" in window.endpoints_pane.status.text()
    assert window.project_pane.zip_button.text().startswith("Guardar .zip")
