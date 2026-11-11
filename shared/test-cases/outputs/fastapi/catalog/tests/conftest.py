"""Fixtures shared by the tests: a fresh application per test, and the credentials to call it."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.main import create_app



@pytest.fixture
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    """The application with empty storage and test credentials."""
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def headers() -> dict[str, str]:
    """Headers of a client allowed to call every endpoint."""
    return {}
