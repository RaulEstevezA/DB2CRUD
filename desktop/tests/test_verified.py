"""How far a stack is verified. Mirrors web/src/core/compatibility/verified.test.ts."""

import json

from model2api.core.compatibility.stack import FRAMEWORKS, databases_for
from model2api.core.compatibility.verified import VERIFIED, verification


def stack(framework: str, architecture: str, persistence: str, database: str | None, auth: str) -> dict:
    return {
        "framework": framework,
        "architecture": architecture,
        "persistence": persistence,
        "database": database,
        "auth": auth,
    }


def test_tells_exact_stacks_stacks_verified_by_parts_and_unverified_ones():
    assert verification(stack("fastapi", "layered", "memory", None, "none")) == "verified"
    assert verification(stack("fastapi", "modular", "sqlalchemy", "postgresql", "apiKey")) == "parts"
    assert verification(stack("nestjs", "modular", "memory", None, "none")) == "verified"
    # No scenario has run FastAPI on MongoDB
    assert verification(stack("fastapi", "layered", "sqlalchemy", "mongodb", "none")) == "unverified"


def test_only_lists_stacks_the_matrix_offers():
    for item in VERIFIED:
        framework = next(candidate for candidate in FRAMEWORKS if candidate["id"] == item["framework"])
        assert item["architecture"] in framework["architectures"]
        assert item["auth"] in framework["auth"]
        databases = databases_for(item["framework"], item["persistence"])
        offered = len(databases) == 0 if item["database"] is None else item["database"] in databases
        assert offered, json.dumps(item)
