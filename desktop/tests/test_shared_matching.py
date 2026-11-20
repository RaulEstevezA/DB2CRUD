"""The matching of application models with tables in shared/test-cases/matching/: the desktop version must give the
matching the web version gives (web/src/core/matching/test/matching.test.ts writes it in expected.json)."""

import json

import pytest

from db2crud.core.importers.ddl.ddl import read_ddl
from db2crud.core.importers.registry import detect_format, parse_input
from db2crud.core.matching.matching import match_models

from .conftest import SHARED_CASES

CASES = sorted(path for path in (SHARED_CASES / "matching").iterdir() if path.is_dir())


@pytest.mark.parametrize("folder", CASES, ids=lambda folder: folder.name)
def test_matches_like_the_web_version(folder):
    database = read_ddl((folder / "schema.sql").read_text(encoding="utf-8"))
    models_file = next(path for path in folder.iterdir() if path.name.startswith("models."))
    text = models_file.read_text(encoding="utf-8")
    models = parse_input(text, detect_format(text, models_file.name))
    assert models["ok"], models
    matching = match_models(database, models["schema"])
    assert matching == json.loads((folder / "expected.json").read_text(encoding="utf-8"))
