"""Tests of the FastAPI project (pytest + TestClient). They call every enabled endpoint the way a client would:
create and read back, list and paginate, replace, update part, delete, missing items, invalid bodies, missing
credentials, missing roles, and business operations still to write. Mirrors
web/src/core/generators/frameworks/fastapi/tests.ts.

Bodies come from the language-neutral samples (common/samples.py); references are filled by creating the
referenced items first.
"""

import re

from ....js import number_text
from ...common.samples import sample_body, updatable_field
from ...common.testing import (
    TEST_API_KEY,
    TEST_JWT_SECRET,
    comparable_fields,
    creatable,
    find_endpoint,
    fixed_path,
    key_wire,
    missing_key,
    path_with_key,
    sample_keys_differ,
)
from ...common.text import file_text, lines
from ...languages.python.python import py_docstring, py_literal, py_string
from .context import FastApiContext, names


def _fixed_url(endpoint: dict, resource: dict, value: str) -> str:
    """A Python string for a path with a fixed key value: "/customers/999999"."""
    return py_string(fixed_path(endpoint, resource, value))


def _url(endpoint: dict, resource: dict, key: str) -> str:
    """A Python f-string for a path with the key (and any other parameter) filled in."""
    path = path_with_key(endpoint, resource).replace("{key}", f"{{{key}}}", 1)
    return f"f{py_string(path)}" if "{" in path else py_string(path)


def _subscript(path: list) -> str:
    """Python subscripts for a place in a body: ["lines"][0]["productId"]."""
    return "".join(f"[{part if isinstance(part, int) else py_string(part)}]" for part in path)


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def _article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def _helpers_file(context: FastApiContext) -> dict:
    blocks: list[str] = []
    spec = context.spec
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        variable = names(resource)
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"    body{_subscript(reference['path'])} = create_{names(target)['one']}(client, headers)"
                f"[{py_string(key_wire(target))}]"
            )
        one = variable["one"]
        blocks.append(
            lines(
                f"def {one}_payload(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:",
                f'    """A valid body to create {_article(resource["singular"])}, with the items it refers to created first."""',
                f"    body: dict[str, Any] = {py_literal(first['body'])} if variant == 0 else {py_literal(second['body'])}",
                fills,
                "    return body",
                "",
                "",
                f"def create_{one}(client: TestClient, headers: dict[str, str], variant: int = 0) -> dict[str, Any]:",
                f'    """Creates {_article(resource["singular"])} and returns it as the API answers."""',
                f"    response = client.post({py_string(create['path'])}, json={one}_payload(client, headers, variant), headers=headers)",
                f"    assert response.status_code == {number_text(create['status'])}, response.text",
                "    return response.json()",
            )
        )
    content = lines(
        py_docstring("Builders of valid request bodies, and helpers that create items through the API."),
        "",
        "from typing import Any",
        "",
        "from fastapi.testclient import TestClient",
        "",
        "",
        "\n\n\n".join(blocks) if blocks else "# No resource can be created through the API, so no helper is needed",
    )
    return {"path": "tests/helpers.py", "content": file_text(content)}


def _conftest_file(context: FastApiContext) -> dict:
    auth = context.settings["auth"]
    roles = context.spec["roles"]
    jwt = auth == "jwt"
    content = lines(
        py_docstring("Fixtures shared by the tests: a fresh application per test, and the credentials to call it."),
        "",
        "import os",
        jwt and "from datetime import UTC, datetime, timedelta",
        "from collections.abc import Iterator",
        "",
        jwt and "import jwt",
        "import pytest",
        "from fastapi.testclient import TestClient",
        "",
        "from app.main import create_app",
        context.sql and "from app.db import Base",
        "",
        auth == "apiKey" and f"TEST_API_KEY = {py_string(TEST_API_KEY)}",
        jwt and f"TEST_JWT_SECRET = {py_string(TEST_JWT_SECRET)}",
        jwt and f"ALL_ROLES = [{', '.join(map(py_string, roles))}]",
        "",
        "",
        "@pytest.fixture",
        "def client(tmp_path, monkeypatch) -> Iterator[TestClient]:",
        '    """The application with empty storage and test credentials."""',
        auth == "apiKey" and '    monkeypatch.setenv("API_KEYS", TEST_API_KEY)',
        jwt
        and [
            '    monkeypatch.setenv("JWT_SECRET", TEST_JWT_SECRET)',
            '    monkeypatch.delenv("JWT_AUDIENCE", raising=False)',
            '    monkeypatch.delenv("JWT_ISSUER", raising=False)',
        ],
        context.sql
        and [
            "    # TEST_DATABASE_URL runs the tests on a real database; by default, a SQLite file per test",
            '    url = os.environ.get("TEST_DATABASE_URL") or f"sqlite:///{tmp_path / \'test.db\'}"',
            '    monkeypatch.setenv("DATABASE_URL", url)',
        ],
        "    app = create_app()",
        "    with TestClient(app) as test_client:",
        "        yield test_client",
        context.sql and ["    Base.metadata.drop_all(app.state.engine)", "    app.state.engine.dispose()"],
        "",
        "",
        jwt
        and [
            "def token(roles: list[str]) -> str:",
            '    """A token signed with the test secret, valid for one hour."""',
            '    claims = {"sub": "tests", "roles": roles, "exp": datetime.now(UTC) + timedelta(hours=1)}',
            '    return jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")',
            "",
            "",
        ],
        "@pytest.fixture",
        "def headers() -> dict[str, str]:",
        '    """Headers of a client allowed to call every endpoint."""',
        auth == "none" and "    return {}",
        auth == "apiKey" and '    return {"X-API-Key": TEST_API_KEY}',
        jwt and '    return {"Authorization": f"Bearer {token(ALL_ROLES)}"}',
        jwt
        and [
            "",
            "",
            "@pytest.fixture",
            "def headers_without_roles() -> dict[str, str]:",
            '    """Headers of a client with a valid token but no role."""',
            '    return {"Authorization": f"Bearer {token([])}"}',
        ],
    )
    # os is only needed for the database URL
    text = content if context.sql else content.replace("import os\n", "", 1)
    return {"path": "tests/conftest.py", "content": file_text(text)}


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")


def _py_name_of(endpoint: dict) -> str:
    return _CAMEL.sub(r"\1_\2", endpoint["name"]).lower()


def _py_name_of_wire(wire: str) -> str:
    return _CAMEL.sub(r"\1_\2", wire).lower()


def _resource_tests(context: FastApiContext, resource: dict) -> dict:
    spec = context.spec
    variable = names(resource)
    one = variable["one"]
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    helpers: set[str] = set()
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    client_args = "client: TestClient, headers: dict[str, str]"

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            tests.append(
                lines(
                    f"def test_{_py_name_of(endpoint)}_storage_is_pending({client_args}) -> None:",
                    f"    response = client.get({_fixed_url(endpoint, resource, missing_key(resource))}, headers=headers)",
                    "    assert response.status_code == 501",
                    '    assert response.json()["error"]["code"] == "not_implemented"',
                )
            )
    else:
        if create and not can_create:
            reason = problem if problem is not None else "An item it refers to cannot be created through the API."
            todo = problem if problem is not None else "write a body with the items it refers to"
            tests.append(
                lines(
                    f"@pytest.mark.skip(reason={py_string(reason)})",
                    f"def test_create_{one}() -> None:",
                    f"    # TODO: {todo}",
                    "    pass",
                )
            )
        if can_create:
            helpers.add(f"create_{one}")
            helpers.add(f"{one}_payload")
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            checks = [
                f"    assert created[{py_string(wire)}] == payload[{py_string(wire)}]"
                for wire in comparable_fields(resource, sent)
            ]
            tests.append(
                lines(
                    f"def test_create_{one}({client_args}) -> None:",
                    f"    payload = {one}_payload(client, headers)",
                    f"    response = client.post({py_string(create['path'])}, json=payload, headers=headers)",
                    f"    assert response.status_code == {number_text(create['status'])}, response.text",
                    "    created = response.json()",
                    f"    assert created[{py_string(key)}] is not None",
                    checks,
                )
            )
            required = next(
                (
                    field
                    for field in resource["fields"]
                    if field["required"] and field["access"] != "readOnly" and not field.get("reference")
                ),
                None,
            )
            if required:
                tests.append(
                    lines(
                        f"def test_create_{one}_without_{_py_name_of_wire(required['wire'])}({client_args}) -> None:",
                        f"    payload = {one}_payload(client, headers)",
                        f"    del payload[{py_string(required['wire'])}]",
                        f"    response = client.post({py_string(create['path'])}, json=payload, headers=headers)",
                        "    assert response.status_code == 400",
                        '    error = response.json()["error"]',
                        '    assert error["code"] == "validation_error"',
                        f'    assert any(detail["field"] == {py_string(required["wire"])} for detail in error["details"])',
                    )
                )
            if resource["key"]["generated"] is None:
                tests.append(
                    lines(
                        f"def test_create_{one}_twice({client_args}) -> None:",
                        f"    created = create_{one}(client, headers)",
                        f"    payload = {one}_payload(client, headers)",
                        f"    payload[{py_string(key)}] = created[{py_string(key)}]",
                        f"    response = client.post({py_string(create['path'])}, json=payload, headers=headers)",
                        "    assert response.status_code == 409",
                    )
                )
        if get:
            if can_create:
                tests.append(
                    lines(
                        f"def test_get_{one}({client_args}) -> None:",
                        f"    created = create_{one}(client, headers)",
                        f"    key = created[{py_string(key)}]",
                        f"    response = client.get({_url(get, resource, 'key')}, headers=headers)",
                        "    assert response.status_code == 200, response.text",
                        "    assert response.json() == created",
                    )
                )
            tests.append(
                lines(
                    f"def test_get_missing_{one}({client_args}) -> None:",
                    f"    response = client.get({_fixed_url(get, resource, missing_key(resource))}, headers=headers)",
                    "    assert response.status_code == 404",
                    '    assert response.json()["error"]["code"] == "not_found"',
                )
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            list_name = _py_name_of(listing)
            tests.append(
                lines(
                    f"def test_{list_name}({client_args}) -> None:",
                    can_create and f"    create_{one}(client, headers)",
                    can_create and distinct and f"    create_{one}(client, headers, variant=1)",
                    f"    response = client.get({py_string(listing['path'])}, headers=headers)",
                    "    assert response.status_code == 200, response.text",
                    [
                        "    page = response.json()",
                        f'    assert page["total"] == {count}',
                        '    assert page["page"] == 1',
                    ]
                    if listing["pagination"]
                    else f"    assert len(response.json()) == {count}",
                )
            )
            if listing["pagination"] and can_create and distinct:
                tests.append(
                    lines(
                        f"def test_{list_name}_by_page({client_args}) -> None:",
                        f"    create_{one}(client, headers)",
                        f"    create_{one}(client, headers, variant=1)",
                        f'    response = client.get({py_string(listing["path"])}, params={{"page": 2, "size": 1}}, headers=headers)',
                        "    assert response.status_code == 200, response.text",
                        "    page = response.json()",
                        '    assert page["total"] == 2',
                        '    assert len(page["items"]) == 1',
                        '    assert page["page"] == 2',
                    )
                )
            if listing["pagination"]:
                tests.append(
                    lines(
                        f"def test_{list_name}_rejects_a_bad_page({client_args}) -> None:",
                        f'    response = client.get({py_string(listing["path"])}, params={{"page": 0}}, headers=headers)',
                        "    assert response.status_code == 400",
                    )
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            second = sample_body(spec, resource, 1)["sample"]["body"]
            tests.append(
                lines(
                    f"def test_replace_{one}({client_args}) -> None:",
                    f"    created = create_{one}(client, headers)",
                    f"    key = created[{py_string(key)}]",
                    f"    payload = {one}_payload(client, headers, variant=1)",
                    resource["key"]["generated"] is None and f"    payload[{py_string(key)}] = key",
                    f"    response = client.put({_url(replace, resource, 'key')}, json=payload, headers=headers)",
                    "    assert response.status_code == 200, response.text",
                    [
                        f"    assert response.json()[{py_string(wire)}] == payload[{py_string(wire)}]"
                        for wire in comparable_fields(resource, second)
                        if wire != key
                    ],
                )
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            tests.append(
                lines(
                    f"def test_update_{one}({client_args}) -> None:",
                    f"    created = create_{one}(client, headers)",
                    f"    key = created[{py_string(key)}]",
                    f"    response = client.patch({_url(update, resource, 'key')}, json={{{py_string(field['wire'])}: {py_literal(value)}}}, headers=headers)",
                    "    assert response.status_code == 200, response.text",
                    f"    assert response.json()[{py_string(field['wire'])}] == {py_literal(value)}",
                )
            )
            if not field["nullable"]:
                tests.append(
                    lines(
                        f"def test_update_{one}_rejects_null({client_args}) -> None:",
                        f"    created = create_{one}(client, headers)",
                        f"    key = created[{py_string(key)}]",
                        f"    response = client.patch({_url(update, resource, 'key')}, json={{{py_string(field['wire'])}: None}}, headers=headers)",
                        "    assert response.status_code == 400",
                    )
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            tests.append(
                lines(
                    f"def test_delete_{one}({client_args}) -> None:",
                    f"    created = create_{one}(client, headers)",
                    f"    key = created[{py_string(key)}]",
                    f"    response = client.delete({_url(remove, resource, 'key')}, headers=headers)",
                    f"    assert response.status_code == {number_text(remove['status'])}, response.text",
                    get
                    and [f"    assert client.get({_url(get, resource, 'key')}, headers=headers).status_code == 404"],
                )
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if needs_item and not can_create:
                continue
            if endpoint["input"] == "none":
                body = ""
            elif endpoint["input"] == "partial":
                body = ", json={}"
            else:
                body = f", json={one}_payload(client, headers)"
            if endpoint["input"] == "resource" and not can_create:
                continue
            tests.append(
                lines(
                    f"def test_{_py_name_of(endpoint)}_is_pending({client_args}) -> None:",
                    needs_item
                    and [f"    created = create_{one}(client, headers)", f"    key = created[{py_string(key)}]"],
                    f"    response = client.request({py_string(endpoint['method'])}, {_url(endpoint, resource, 'key')}{body}, headers=headers)",
                    "    # TODO: replace this test when the operation is written",
                    "    assert response.status_code == 501",
                )
            )
    # Protection, checked on the first endpoint that has it
    protected = next((endpoint for endpoint in resource["endpoints"] if endpoint["access"] != "public"), None)
    if (
        protected
        and context.settings["auth"] != "none"
        and protected["method"] == "GET"
        and protected["input"] == "none"
    ):
        tests.append(
            lines(
                f"def test_{_py_name_of(protected)}_needs_credentials(client: TestClient) -> None:",
                f"    response = client.get({_fixed_url(protected, resource, missing_key(resource))})",
                "    assert response.status_code == 401",
                '    assert response.json()["error"]["code"] == "unauthorized"',
            )
        )
    with_roles = next(
        (
            endpoint
            for endpoint in resource["endpoints"]
            if endpoint["access"] == "roles" and endpoint["method"] == "GET" and endpoint["input"] == "none"
        ),
        None,
    )
    if with_roles and context.settings["auth"] == "jwt":
        tests.append(
            lines(
                f"def test_{_py_name_of(with_roles)}_needs_a_role(client: TestClient, headers_without_roles: dict[str, str]) -> None:",
                f"    response = client.get({_fixed_url(with_roles, resource, missing_key(resource))}, headers=headers_without_roles)",
                "    assert response.status_code == 403",
            )
        )
    uses_skip = any(test.startswith("@pytest.mark.skip") for test in tests)
    imported = sorted(helpers)
    content = lines(
        py_docstring(f"Tests of the {resource['plural']} endpoints."),
        "",
        uses_skip and "import pytest",
        "from fastapi.testclient import TestClient",
        bool(imported) and ["", f"from tests.helpers import {', '.join(imported)}"],
        "",
        "",
        "\n\n\n".join(tests) if tests else f"def test_{variable['many']}_have_no_endpoints() -> None:\n    pass",
    )
    return {"path": f"tests/test_{variable['many']}.py", "content": file_text(content)}


def test_files(context: FastApiContext) -> list[dict]:
    files = [_conftest_file(context), _helpers_file(context), {"path": "tests/__init__.py", "content": ""}]
    for resource in context.spec["resources"]:
        files.append(_resource_tests(context, resource))
    return files
