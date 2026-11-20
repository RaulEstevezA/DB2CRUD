"""The reader of Mapper projects and the models input that takes them, on the projects of
shared/test-cases/matching/mapper-* (mirrors web/src/core/interop/mapper/test/read.test.ts)."""

import json

from db2crud.core.interop.mapper.read import invertible, is_mapper_project, mapper_models, read_mapper_project
from db2crud.workspace import models_language, read_models

from .conftest import SHARED_CASES

WRITE = (SHARED_CASES / "matching" / "mapper-write" / "models.mapper.json").read_text(encoding="utf-8")


def _edited(change) -> str:
    value = json.loads(WRITE)
    change(value)
    return json.dumps(value)


def test_both_sides_and_the_mappings_are_read():
    assert is_mapper_project(WRITE)
    read = read_mapper_project(WRITE)
    assert read["ok"]
    project = read["project"]
    assert (project["source"]["model"], project["target"]["model"]) == ("CustomerForm", "Customer")
    assert "concat" in [field["transform"]["kind"] for field in project["mappings"][0]["fields"]]
    assert project["mappings"][0]["ignoredSources"] == ["legacyCode"]
    assert [model["name"] for model in mapper_models(project)["models"]] == ["CustomerForm", "Customer"]


def test_other_files_newer_versions_and_damaged_projects_are_rejected():
    assert read_mapper_project("not json") == {"ok": False, "error": "notJson"}
    assert read_mapper_project('{"format":"model-schema","version":1}') == {"ok": False, "error": "notProject"}
    assert read_mapper_project(_edited(lambda value: value.update(version=2))) == {"ok": False, "error": "newerVersion"}
    damaged = _edited(lambda value: value["mapping"].update(root="Other->Customer"))
    assert read_mapper_project(damaged) == {"ok": False, "error": "invalid", "path": "$.mapping.root"}
    damaged = _edited(lambda value: value["target"].pop("model"))
    assert read_mapper_project(damaged) == {"ok": False, "error": "invalid", "path": "$.target"}


def test_the_transformations_that_can_be_undone_are_known():
    assert invertible({"kind": "direct"})
    assert invertible({"kind": "epoch", "unit": "seconds"})
    assert invertible({"kind": "arithmetic", "operator": "*", "operand": 100})
    assert not invertible({"kind": "arithmetic", "operator": "*", "operand": 0})
    assert invertible({"kind": "enum", "pairs": [{"from": "A", "to": "a"}, {"from": "B", "to": "b"}]})
    assert not invertible({"kind": "enum", "pairs": [{"from": "A", "to": "a"}, {"from": "B", "to": "a"}]})
    assert not invertible({"kind": "enum", "pairs": [{"from": "A", "to": "a"}], "fallback": "a"})
    assert not invertible({"kind": "concat", "separator": " "})
    assert not invertible({"kind": "expression", "expression": "a + b"})


def test_the_models_input_reads_a_mapper_project():
    read = read_models({"text": WRITE, "fileName": "customer.mapper.json"})
    assert read["ok"] and read["project"]["root"] == "CustomerForm->Customer"
    assert len(read["schema"]["models"]) == 2
    assert models_language({"text": WRITE}) == "json"
