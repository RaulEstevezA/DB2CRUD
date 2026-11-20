"""Reading the database input. Mirrors web/src/app/workspace.test.ts."""

import json

import pytest

from db2crud.examples import EXAMPLES
from db2crud.workspace import TooManyFiles, column_count, gather_files, input_language, read_database, source_label

from .conftest import SHARED_CASES


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


def test_gathers_the_readable_files_of_a_folder(tmp_path):
    (tmp_path / "app" / "Models").mkdir(parents=True)
    (tmp_path / "app" / "Models" / "User.php").write_text("<?php class User {}", encoding="utf-8")
    (tmp_path / ".env").write_text("DB_CONNECTION=pgsql\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("# Not code", encoding="utf-8")
    for skipped in ("node_modules", "vendor", ".git"):
        (tmp_path / skipped).mkdir()
        (tmp_path / skipped / "index.js").write_text("module.exports = {}", encoding="utf-8")
    names = [file["name"] for file in gather_files([str(tmp_path)])]
    assert names == [".env", "app/Models/User.php"]


def test_refuses_a_folder_too_large(tmp_path, monkeypatch):
    monkeypatch.setattr("db2crud.workspace.MAX_FILES", 2)
    for index in range(3):
        (tmp_path / f"m{index}.py").write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(TooManyFiles):
        gather_files([str(tmp_path)])


def test_reads_a_whole_project_of_several_files():
    # A Laravel project: migrations, models and .env, read together as the hand-written case expects
    folder = SHARED_CASES / "orm" / "hand" / "eloquent" / "blog"
    files = [file for file in gather_files([str(folder)]) if file["name"] != "expected.json"]
    assert len(files) > 3
    read = read_database({"text": files[0]["text"], "files": files, "selected": 0})
    assert read["ok"]
    assert read["schema"] == json.loads((folder / "expected.json").read_text(encoding="utf-8"))
    assert input_language({"text": "", "files": files, "selected": 0}) in ("php", "json")


def test_reads_several_sql_files_in_the_order_of_their_names():
    files = [
        {"name": "002_index.sql", "text": "CREATE INDEX ix_users_email ON users (email);"},
        {"name": "001_users.sql", "text": "CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT NOT NULL);"},
    ]
    read = read_database({"text": files[0]["text"], "files": files, "selected": 0})
    assert read["ok"]
    assert read["schema"]["tables"][0]["indexes"] == [{"name": "ix_users_email", "columns": ["email"]}]
    assert input_language({"text": files[0]["text"], "files": files, "selected": 0}) == "sql"
    assert read_database({"text": "", "files": [{"name": "a.sql", "text": "  "}], "selected": 0}) is None
