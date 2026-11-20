"""Reading the database input. Mirrors web/src/app/workspace.test.ts."""

from db2crud.examples import EXAMPLES
from db2crud.workspace import column_count, input_language, read_database, source_label


def test_reads_nothing_while_the_input_is_empty():
    assert read_database({"text": "  "}) is None


def test_reads_every_built_in_example():
    for example in EXAMPLES:
        read = read_database({"text": example["text"]})
        assert read["ok"], example["id"]
        assert column_count(read["schema"]) > 0


def test_reads_orm_code_when_the_input_is_not_json():
    text = (
        "from sqlalchemy import Column, Integer\n\n"
        'class User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n'
    )
    read = read_database({"text": text})
    assert read["ok"]
    assert source_label(read["schema"]) == "SQLAlchemy"
    assert read["schema"]["dialect"] is None
    assert input_language({"text": text}) == "python"
    assert input_language({"text": EXAMPLES[0]["text"]}) == "json"


def test_reads_sql_ddl_when_the_input_is_neither_a_project_nor_orm_code():
    text = "CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(120) NOT NULL UNIQUE\n);\n"
    read = read_database({"text": text})
    assert read["ok"]
    assert source_label(read["schema"]) == "SQL DDL"
    assert read["schema"]["dialect"] == "postgresql"
    assert [table["name"] for table in read["schema"]["tables"]] == ["users"]
    assert input_language({"text": text}) == "sql"
    assert read_database({"text": "CREATE TABLE AS SELECT 1;"}) == {"ok": False, "error": "noTables"}


def test_says_why_an_input_cannot_be_read():
    assert read_database({"text": '{ "a": '}) == {"ok": False, "error": "notJson"}
    assert read_database({"text": "export interface User { id: number }"}) == {"ok": False, "error": "unknownInput"}
    assert read_database({"text": "import sqlalchemy\n"}) == {"ok": False, "error": "noTables"}


def test_names_model2db_projects_with_their_output():
    read = read_database({"text": EXAMPLES[0]["text"]})
    assert source_label(read["schema"]).startswith("Model2DB (")
