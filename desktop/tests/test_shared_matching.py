"""The matching of application models with tables in shared/test-cases/matching/: the desktop version must give the
matching and the conversion plans the web version gives (web/src/core/matching/test/matching.test.ts writes them in
expected.json, web/src/core/conversions/test/plan.test.ts in plan.json)."""

import json

import pytest

from db2crud.core.conversions.plan import conversions_available, plan_conversions, without_hidden
from db2crud.core.crud.edit import accept, choose_model, choose_source, find_decision, pending_decisions
from db2crud.core.crud.propose import propose_crud
from db2crud.core.importers.ddl.ddl import read_ddl
from db2crud.core.importers.registry import detect_format, parse_input
from db2crud.core.interop.mapper.read import is_mapper_project, mapper_models, read_mapper_project
from db2crud.core.matching.matching import match_models

from .conftest import SHARED_CASES

CASES = sorted(path for path in (SHARED_CASES / "matching").iterdir() if path.is_dir())


def read_case(folder):
    """The database and the models of a case, with the Mapper project they come from when they do."""
    database = read_ddl((folder / "schema.sql").read_text(encoding="utf-8"))
    models_file = next(path for path in folder.iterdir() if path.name.startswith("models."))
    text = models_file.read_text(encoding="utf-8")
    if is_mapper_project(text):
        read = read_mapper_project(text)
        assert read["ok"], read
        return database, mapper_models(read["project"]), read["project"]
    models = parse_input(text, detect_format(text, models_file.name))
    assert models["ok"], models
    return database, models["schema"], None


@pytest.mark.parametrize("folder", CASES, ids=lambda folder: folder.name)
def test_matches_like_the_web_version(folder):
    database, models, project = read_case(folder)
    matching = match_models(database, models, None, project)
    assert matching == json.loads((folder / "expected.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("folder", CASES, ids=lambda folder: folder.name)
def test_plans_the_conversions_like_the_web_version(folder):
    database, models, project = read_case(folder)
    design = propose_crud(database, None, models, project)
    plans = plan_conversions(database, design, {"schema": models, "project": project})
    assert plans == json.loads((folder / "plan.json").read_text(encoding="utf-8"))


def test_conversions_are_written_only_for_models_in_the_language_of_the_project_or_in_none():
    _, models, _ = read_case(SHARED_CASES / "matching" / "shop-typescript")
    assert conversions_available({"schema": models}, "typescript") == {"ok": True}
    expected = {"ok": False, "reason": "language", "models": "typescript", "project": "python"}
    assert conversions_available({"schema": models}, "python") == expected
    assert conversions_available({"schema": {**models, "origin": {"format": "json"}}}, "python") == {"ok": True}


# The matching as decisions of the design (mirrors web/src/core/crud/edit.test.ts)

DATABASE, MODELS, _ = read_case(SHARED_CASES / "matching" / "directions-typescript")
START = propose_crud(DATABASE, None, MODELS)


def _models(design, table):
    return next(item for item in design["matching"]["tables"] if item["table"] == table)["models"]


def test_the_models_and_columns_wait_for_the_user_with_the_other_decisions():
    pending = pending_decisions(START)
    assert {"kind": "model", "table": "products", "direction": "input"} in pending
    assert {"kind": "source", "table": "orders", "direction": "output", "column": "status"} in pending


def test_a_chosen_source_is_kept_when_the_design_is_proposed_again():
    edited = propose_crud(DATABASE, choose_source(START, "orders", "input", "status", None), MODELS)
    written = next(item for item in _models(edited, "orders") if item["direction"] == "input")
    status = next(item for item in written["columns"] if item["column"] == "status")
    assert status["source"]["value"] is None and status["source"]["manual"]


def test_another_model_matches_the_columns_again():
    edited = propose_crud(DATABASE, choose_model(START, "products", "input", "ProductCommand"), MODELS)
    match = _models(edited, "products")[0]
    assert match["model"]["value"] == "ProductCommand" and match["model"]["manual"]
    assert next(item for item in match["columns"] if item["column"] == "price")["source"]["confidence"] == "conflict"


def test_the_field_chosen_brings_its_conflicts_and_leaves_the_other_unused():
    source = {"kind": "field", "field": "email"}
    edited = propose_crud(DATABASE, choose_source(START, "customers", "both", "full_name", source), MODELS)
    match = _models(edited, "customers")[0]
    assert next(item for item in match["columns"] if item["column"] == "full_name")["conflicts"] == []
    assert match["unused"] == ["fullName"]


def test_a_pending_model_is_confirmed_as_it_is():
    ref = {"kind": "model", "table": "products", "direction": "input"}
    decision = find_decision(accept(START, ref), ref)
    assert decision["status"] == "active" and decision["manual"]


def test_the_fields_read_from_a_column_the_service_never_returns_are_left_to_the_user():
    plan = {
        "table": "customers",
        "model": "Customer",
        "direction": "both",
        "write": [{"column": "password_hash", "value": {"kind": "field", "path": ["passwordHash"]}}],
        "read": [
            {"field": "email", "value": {"kind": "column", "column": "email"}},
            {"field": "passwordHash", "value": {"kind": "column", "column": "password_hash"}},
        ],
    }
    todo = {"kind": "todo", "reason": "hidden", "detail": "password_hash"}
    assert without_hidden(plan, ["password_hash"]) == {
        **plan,
        "read": [plan["read"][0], {"field": "passwordHash", "value": todo}],
    }
    assert without_hidden(plan, []) is plan
