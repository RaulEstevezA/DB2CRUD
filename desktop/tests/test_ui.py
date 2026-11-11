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
