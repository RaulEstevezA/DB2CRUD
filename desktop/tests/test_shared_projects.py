"""The projects in shared/test-cases/outputs/: the desktop generators must write exactly the files the web version
writes for every verification scenario (web/src/core/generators/shared.test.ts writes them)."""

import json

import pytest

from db2crud.core.crud.edit import decide_policy
from db2crud.core.crud.propose import propose_crud
from db2crud.core.generators.registry import generate_project

from .conftest import SHARED_CASES

CASES = sorted((SHARED_CASES / "outputs").glob("*.json"))


@pytest.mark.parametrize("path", CASES, ids=lambda path: path.stem)
def test_writes_the_same_project(path):
    case = json.loads(path.read_text(encoding="utf-8"))
    schema = case["schema"]
    design = propose_crud(schema)
    for item in case["decisions"]:
        design = propose_crud(schema, decide_policy(design, item["table"], item["decision"], item["value"]))
    files = {file["path"]: file["content"] for file in generate_project(schema, design, case["settings"])}
    assert sorted(files) == sorted(case["files"])
    for name, content in case["files"].items():
        assert files[name] == content, name
