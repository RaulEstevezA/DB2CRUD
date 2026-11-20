"""The window, without opening it (QT_QPA_PLATFORM=offscreen): the examples, the design with undo, the settings and
saving the project."""

import zipfile

from db2crud.examples import EXAMPLES
from db2crud.ui.i18n import EN, ES


def test_both_languages_have_the_same_texts():
    assert sorted(vars(EN)) == sorted(vars(ES))


def test_every_example_gives_a_design_and_a_project(window):
    for example in EXAMPLES:
        window.load_example(example["id"])
        session = window.session
        assert session.design is not None, example["id"]
        assert session.files, example["id"]
        assert session.settings["name"] == example["project"]
        assert window.project_pane.code.toPlainText() == next(
            file["content"] for file in session.files if file["path"] == "README.md"
        )


def test_a_choice_is_undone_and_redone(window):
    window.load_example("store")
    session = window.session
    first = session.design["repositories"][0]["queries"][0]
    window.design_pane._controls[f"query:{session.design['repositories'][0]['table']}:{first['id']}"].click()
    assert session.design["repositories"][0]["queries"][0]["include"]["value"] is False
    session.undo()
    assert session.design["repositories"][0]["queries"][0]["include"]["value"] is True
    session.redo()
    assert session.design["repositories"][0]["queries"][0]["include"]["value"] is False


def test_the_settings_change_the_project(window):
    window.load_example("store")
    session = window.session
    session.set_settings(execution="async", serviceTypes="dtos")
    assert any(file["path"].startswith("app/dtos/") for file in session.files)
    assert "async def" in next(file["content"] for file in session.files if file["path"] == "app/unit_of_work.py")


def test_the_project_is_saved_as_a_zip(window, tmp_path):
    window.load_example("store")
    target = tmp_path / "shop.zip"
    window.project_pane.save_zip(str(target))
    with zipfile.ZipFile(target) as archive:
        assert len(archive.namelist()) == len(window.session.files)


def test_the_language_changes_every_pane(window):
    window.load_example("store")
    window._i18n.set_language("es")
    assert window.database_pane.title.text() == "Base de datos"
    assert window.design_pane.title.text() == "Diseño"
    assert window.project_pane.title.text() == "Proyecto"
    assert window.project_pane.zip_button.text().startswith("Guardar .zip")


def test_a_project_folder_is_opened_with_its_files(window):
    from .conftest import SHARED_CASES

    pane = window.database_pane
    pane.open_paths([str(SHARED_CASES / "orm" / "hand" / "eloquent" / "blog")])
    session = window.session
    names = [file["name"] for file in session.input["files"]]
    assert "database/migrations/0001_01_01_000000_create_users_table.php" in names
    assert session.read["ok"]
    assert session.read["schema"]["source"]["format"] == "eloquent"
    assert pane.file_list.count() == len(names)
    assert session.design is not None
    # Choosing a file shows it; editing it changes that file only
    row = names.index("app/Models/Tag.php")
    pane.file_list.setCurrentRow(row)
    assert pane.editor.toPlainText() == session.input["files"][row]["text"]
    pane.set_text(pane.editor.toPlainText() + "\n// edited\n")
    assert session.input["files"][row]["text"].endswith("// edited\n")
    assert session.input["selected"] == row
    assert session.read["ok"]


def test_a_folder_with_nothing_to_read_says_so(window, tmp_path):
    (tmp_path / "notes.txt").write_text("nothing", encoding="utf-8")
    window.database_pane.open_paths([str(tmp_path)])
    assert window.database_pane.status.text() == EN.no_readable_files


def test_the_application_models_are_matched_with_the_tables(window):
    from PySide6.QtWidgets import QLabel

    window.load_example("store")
    pane = window.database_pane
    pane.source_tabs.setCurrentIndex(1)
    pane.set_text("export interface Customer {\n  id: number\n  email: string\n  phone?: string\n}\n")
    session = window.session
    assert session.models_read["ok"]
    assert pane.status.text() == EN.models_summary("TypeScript", 1)
    match = next(item for item in session.matching["tables"] if item["table"] == "customers")
    assert match["models"][0]["model"]["value"] == "Customer"
    texts = [label.text() for label in window.design_pane.findChildren(QLabel)]
    assert "← email" in texts
    # The database tab keeps its own text
    pane.source_tabs.setCurrentIndex(0)
    assert pane.editor.toPlainText() == session.input["text"]
