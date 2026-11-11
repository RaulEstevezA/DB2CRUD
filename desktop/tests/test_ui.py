"""The window, without opening it (QT_QPA_PLATFORM=offscreen): the examples, reading the input and the language."""

from model2api.examples import EXAMPLES
from model2api.ui.i18n import EN, ES


def test_both_languages_have_the_same_texts():
    assert sorted(vars(EN)) == sorted(vars(ES))


def test_every_example_is_read(window):
    for example in EXAMPLES:
        window.load_example(example["id"])
        session = window.session
        assert session.schema is not None, example["id"]
        assert session.schema["models"], example["id"]
        assert window.models_pane.editor.toPlainText() == example["text"]


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


def test_the_language_changes_the_window(window):
    window.load_example("store")
    window._i18n.set_language("es")
    assert window.models_pane.title.text() == "Modelos"
    assert "modelos" in window.models_pane.status.text()
