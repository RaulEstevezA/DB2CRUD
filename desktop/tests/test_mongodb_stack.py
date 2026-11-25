"""A document database is offered the stacks made for it, and a relational one the others."""

from db2crud.core.settings.settings import (
    DEFAULT_SETTINGS,
    change_settings,
    normalize_settings,
    settings_for,
    stacks_for,
)
from db2crud.ui.i18n import EN, ES
from db2crud.workspace import input_language, read_database, source_label

VALIDATOR = '{ $jsonSchema: { bsonType: "object", title: "users", properties: { name: { bsonType: "string" } } } }'


def test_stack_follows_the_database():
    settings = normalize_settings(DEFAULT_SETTINGS)
    assert [stack["orm"] for stack in stacks_for("mongodb")] == [
        "beanie",
        "mongoose",
        "springdata",
        "mongodriver",
        "mongophp",
        "mongokotlin",
    ]
    assert settings_for("mongodb", settings)["database"] == "mongodb"
    assert settings_for("postgresql", settings) == settings
    assert settings_for("postgresql", settings_for("mongodb", settings))["orm"] != "mongoose"
    assert settings_for(None, settings) == settings


def test_brings_its_own_place_for_transactions():
    settings = normalize_settings({**DEFAULT_SETTINGS, "transactions": "operation"})
    documents = settings_for("mongodb", settings)
    assert documents["transactions"] == "repository"
    assert change_settings(documents, {"transactions": "operation"})["transactions"] == "operation"
    assert settings_for("postgresql", documents)["transactions"] == "operation"


def test_reads_one_validator():
    read = read_database({"text": VALIDATOR})
    assert read["ok"] and [table["name"] for table in read["schema"]["tables"]] == ["users"]
    assert input_language({"text": VALIDATOR}) == "typescript"
    # Any other object is a Model2DB project
    assert read_database({"text": '{"a": 1}'})["ok"] is False


def test_reads_sample_documents():
    text = '{ "_id": { "$oid": "65a000000000000000000001" }, "name": "Ana" }'
    read = read_database({"text": text, "fileName": "shop.people.json"})
    tables = read["schema"]["tables"]
    assert [(table["name"], [column["name"] for column in table["columns"]]) for table in tables] == [
        ("people", ["_id", "name"])
    ]
    assert source_label(read["schema"]) == "MongoDB documents"
    # No value of a document goes into the schema
    assert "Ana" not in str(read)
    assert read_database({"text": '{ "name": "Ana" }'})["ok"] is False


def test_notes_are_explained_in_both_languages():
    note = {"code": "documents.few", "params": {"table": "people", "count": 1}}
    assert EN.note(note).startswith("people: 1 document.")
    assert ES.note(note).startswith("people: 1 documento.")
    assert EN.note({"code": "other", "params": {"table": "people"}}) == "other · people"
