"""The workspace logic of the window. Mirrors web/src/app/workspace.test.ts."""

from model2api.workspace import field_count, read_input


def test_detects_the_format_when_none_is_chosen():
    read = read_input({"text": "export interface User { id: number; name: string }", "format": None})
    assert read["format"] == "typescript"
    assert read["outcome"]["ok"]
    assert field_count(read["outcome"]["schema"]) == 2


def test_uses_the_chosen_format_and_reports_where_an_error_is():
    outcome = read_input({"text": '{"id": 1,}', "format": "json"})["outcome"]
    assert outcome["ok"] is False
    assert outcome["error"]["code"] == "syntax"
    assert outcome["error"]["line"] == 1


def test_reports_an_input_without_models():
    outcome = read_input({"text": "[]", "format": "json"})["outcome"]
    assert outcome == {"ok": False, "error": {"code": "noModels"}}


def test_reads_nothing_while_the_input_is_empty():
    assert read_input({"text": "  ", "format": None}) == {"format": None, "outcome": None}
