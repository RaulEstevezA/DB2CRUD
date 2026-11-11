"""Reading the database input. Mirrors web/src/app/workspace.test.ts."""

from db2crud.examples import EXAMPLES
from db2crud.workspace import column_count, read_database


def test_reads_nothing_while_the_input_is_empty():
    assert read_database({"text": "  "}) is None


def test_reads_every_built_in_example():
    for example in EXAMPLES:
        read = read_database({"text": example["text"]})
        assert read["ok"], example["id"]
        assert column_count(read["schema"]) > 0


def test_says_why_an_input_cannot_be_read():
    assert read_database({"text": "export interface User { id: number }"}) == {"ok": False, "error": "notJson"}
