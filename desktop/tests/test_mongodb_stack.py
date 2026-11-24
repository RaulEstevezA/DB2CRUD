"""A document database is offered the stacks made for it, and a relational one the others."""

from db2crud.core.settings.settings import DEFAULT_SETTINGS, change_settings, normalize_settings, settings_for, stacks_for
from db2crud.workspace import input_language, read_database

VALIDATOR = '{ $jsonSchema: { bsonType: "object", title: "users", properties: { name: { bsonType: "string" } } } }'


def test_stack_follows_the_database():
    settings = normalize_settings(DEFAULT_SETTINGS)
    assert [stack["orm"] for stack in stacks_for("mongodb")] == ["mongoose"]
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
