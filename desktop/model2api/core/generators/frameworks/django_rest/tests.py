"""Tests of the Django REST Framework project (APITestCase: a clean database for every test). They call every
enabled endpoint the way a client would, with the same cases as every other framework (common/testing.py).
Mirrors web/src/core/generators/frameworks/djangoRest/tests.ts.
"""

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
    protected_endpoint,
    required_field,
    role_endpoint,
    sample_keys_differ,
    snake_words,
)
from ...common.text import file_text, lines
from ...languages.python.python import py_class, py_literal, py_string
from .context import DjangoContext, names


def _url(endpoint: dict, resource: dict) -> str:
    path = path_with_key(endpoint, resource)
    return f"f{py_string(path)}" if "{key}" in path else py_string(path)


def _subscript(path: list) -> str:
    return "".join(f"[{part if isinstance(part, int) else py_string(part)}]" for part in path)


def _helpers_file(context: DjangoContext) -> dict:
    auth = context.settings["auth"]
    spec = context.spec
    blocks: list[str] = []
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        one = names(resource)["one"]
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"    body{_subscript(reference['path'])} = create_{names(target)['one']}(client)[{py_string(key_wire(target))}]"
            )
        blocks.append(
            lines(
                f"def {one}_payload(client: APIClient, variant: int = 0) -> dict[str, Any]:",
                f'    """A valid body to create one {resource["singular"]}, with the items it refers to created first."""',
                f"    body: dict[str, Any] = {py_literal(first['body'])} if variant == 0 else {py_literal(second['body'])}",
                fills,
                "    return body",
                "",
                "",
                f"def create_{one}(client: APIClient, variant: int = 0) -> dict[str, Any]:",
                f'    """Creates one {resource["singular"]} and returns it as the API answers."""',
                f'    response = client.post({py_string(create["path"])}, {one}_payload(client, variant), format="json")',
                f"    assert response.status_code == {number_text(create['status'])}, response.content",
                "    return response.json()",
            )
        )
    jwt = auth == "jwt"
    all_roles = ", ".join(map(py_string, spec["roles"]))
    content = lines(
        '"""Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."""',
        "",
        "from typing import Any",
        jwt and "from datetime import UTC, datetime, timedelta",
        "",
        jwt and "import jwt",
        "from django.test import override_settings",
        "from rest_framework.test import APIClient",
        "",
        auth == "none" and ["# The settings every test runs with", "TEST_SETTINGS = override_settings()"],
        auth == "apiKey"
        and [f"TEST_API_KEY = {py_string(TEST_API_KEY)}", "TEST_SETTINGS = override_settings(API_KEYS=[TEST_API_KEY])"],
        jwt
        and [
            f"TEST_JWT_SECRET = {py_string(TEST_JWT_SECRET)}",
            'TEST_SETTINGS = override_settings(JWT_SECRET=TEST_JWT_SECRET, JWT_ALGORITHM="HS256", JWT_AUDIENCE=None, JWT_ISSUER=None)',
            "",
            "",
            "def token(roles: list[str]) -> str:",
            '    """A token signed with the test secret, valid for one hour."""',
            '    claims = {"sub": "tests", "roles": roles, "exp": datetime.now(UTC) + timedelta(hours=1)}',
            '    return jwt.encode(claims, TEST_JWT_SECRET, algorithm="HS256")',
        ],
        "",
        "",
        "def authorize(client: APIClient, roles: list[str] | None = None) -> APIClient:",
        '    """Gives the client the credentials to call every endpoint (or, with roles, only those roles)."""',
        auth == "apiKey" and "    client.credentials(HTTP_X_API_KEY=TEST_API_KEY)",
        jwt
        and f'    client.credentials(HTTP_AUTHORIZATION=f"Bearer {{token(roles if roles is not None else [{all_roles}])}}")',
        "    return client",
        bool(blocks) and ["", "", "\n\n\n".join(blocks)],
    )
    return {"path": "tests/helpers.py", "content": file_text(content)}


def _resource_tests(context: DjangoContext, resource: dict) -> dict:
    spec = context.spec
    name = names(resource)
    one = name["one"]
    key = key_wire(resource)
    tests: list[str] = []
    helpers = {"TEST_SETTINGS", "authorize"}
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")

    def test(method: str, body: list) -> None:
        tests.append(lines(f"    def test_{method}(self) -> None:", *body))

    if create and not can_create:
        reason = problem if problem is not None else "An item it refers to cannot be created through the API."
        todo = problem if problem is not None else "write a body with the items it refers to"
        tests.append(
            lines(
                f"    @skip({py_string(reason)})",
                f"    def test_create_{one}(self) -> None:",
                f"        # TODO: {todo}",
                "        pass",
            )
        )
    if can_create:
        helpers.add(f"create_{one}")
        helpers.add(f"{one}_payload")
        sent = sample_body(spec, resource, 0)["sample"]["body"]
        test(
            f"create_{one}",
            [
                f"        payload = {one}_payload(self.client)",
                f'        response = self.client.post({py_string(create["path"])}, payload, format="json")',
                f"        self.assertEqual(response.status_code, {number_text(create['status'])}, response.content)",
                "        created = response.json()",
                f"        self.assertIsNotNone(created[{py_string(key)}])",
                [
                    f"        self.assertEqual(created[{py_string(wire)}], payload[{py_string(wire)}])"
                    for wire in comparable_fields(resource, sent)
                ],
            ],
        )
        required = required_field(resource)
        if required:
            test(
                f"create_{one}_without_{snake_words(required['wire'])}",
                [
                    f"        payload = {one}_payload(self.client)",
                    f"        del payload[{py_string(required['wire'])}]",
                    f'        response = self.client.post({py_string(create["path"])}, payload, format="json")',
                    "        self.assertEqual(response.status_code, 400)",
                    '        error = response.json()["error"]',
                    '        self.assertEqual(error["code"], "validation_error")',
                    f'        self.assertTrue(any(detail["field"] == {py_string(required["wire"])} for detail in error["details"]))',
                ],
            )
        if resource["key"]["generated"] is None:
            test(
                f"create_{one}_twice",
                [
                    f"        created = create_{one}(self.client)",
                    f"        payload = {one}_payload(self.client)",
                    f"        payload[{py_string(key)}] = created[{py_string(key)}]",
                    f'        response = self.client.post({py_string(create["path"])}, payload, format="json")',
                    "        self.assertEqual(response.status_code, 409)",
                ],
            )
    if get:
        if can_create:
            test(
                f"get_{one}",
                [
                    f"        created = create_{one}(self.client)",
                    f"        key = created[{py_string(key)}]",
                    f"        response = self.client.get({_url(get, resource)})",
                    "        self.assertEqual(response.status_code, 200, response.content)",
                    "        self.assertEqual(response.json(), created)",
                ],
            )
        test(
            f"get_missing_{one}",
            [
                f"        response = self.client.get({py_string(fixed_path(get, resource, missing_key(resource)))})",
                "        self.assertEqual(response.status_code, 404)",
                '        self.assertEqual(response.json()["error"]["code"], "not_found")',
            ],
        )
    if listing:
        distinct = sample_keys_differ(spec, resource)
        count = (2 if distinct else 1) if can_create else 0
        list_name = snake_words(listing["name"])
        test(
            list_name,
            [
                can_create and f"        create_{one}(self.client)",
                can_create and distinct and f"        create_{one}(self.client, variant=1)",
                f"        response = self.client.get({py_string(listing['path'])})",
                "        self.assertEqual(response.status_code, 200, response.content)",
                [
                    f'        self.assertEqual(response.json()["total"], {count})',
                    '        self.assertEqual(response.json()["page"], 1)',
                ]
                if listing["pagination"]
                else f"        self.assertEqual(len(response.json()), {count})",
            ],
        )
        if listing["pagination"] and can_create and distinct:
            test(
                f"{list_name}_by_page",
                [
                    f"        create_{one}(self.client)",
                    f"        create_{one}(self.client, variant=1)",
                    f'        response = self.client.get({py_string(listing["path"])}, {{"page": 2, "size": 1}})',
                    "        self.assertEqual(response.status_code, 200, response.content)",
                    '        self.assertEqual(response.json()["total"], 2)',
                    '        self.assertEqual(len(response.json()["items"]), 1)',
                ],
            )
        if listing["pagination"]:
            test(
                f"{list_name}_rejects_a_bad_page",
                [
                    f'        response = self.client.get({py_string(listing["path"])}, {{"page": 0}})',
                    "        self.assertEqual(response.status_code, 400)",
                ],
            )
    replace = find_endpoint(resource, "replace")
    if replace and can_create:
        second = sample_body(spec, resource, 1)["sample"]["body"]
        test(
            f"replace_{one}",
            [
                f"        created = create_{one}(self.client)",
                f"        key = created[{py_string(key)}]",
                f"        payload = {one}_payload(self.client, variant=1)",
                resource["key"]["generated"] is None and f"        payload[{py_string(key)}] = key",
                f'        response = self.client.put({_url(replace, resource)}, payload, format="json")',
                "        self.assertEqual(response.status_code, 200, response.content)",
                [
                    f"        self.assertEqual(response.json()[{py_string(wire)}], payload[{py_string(wire)}])"
                    for wire in comparable_fields(resource, second)
                    if wire != key
                ],
            ],
        )
    update = find_endpoint(resource, "update")
    field = updatable_field(resource)
    if update and can_create and field:
        value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
        wire = py_string(field["wire"])
        test(
            f"update_{one}",
            [
                f"        created = create_{one}(self.client)",
                f"        key = created[{py_string(key)}]",
                f'        response = self.client.patch({_url(update, resource)}, {{{wire}: {py_literal(value)}}}, format="json")',
                "        self.assertEqual(response.status_code, 200, response.content)",
                f"        self.assertEqual(response.json()[{wire}], {py_literal(value)})",
            ],
        )
        if not field["nullable"]:
            test(
                f"update_{one}_rejects_null",
                [
                    f"        created = create_{one}(self.client)",
                    f"        key = created[{py_string(key)}]",
                    f'        response = self.client.patch({_url(update, resource)}, {{{wire}: None}}, format="json")',
                    "        self.assertEqual(response.status_code, 400)",
                ],
            )
    remove = find_endpoint(resource, "delete")
    if remove and can_create:
        test(
            f"delete_{one}",
            [
                f"        created = create_{one}(self.client)",
                f"        key = created[{py_string(key)}]",
                f"        response = self.client.delete({_url(remove, resource)})",
                f"        self.assertEqual(response.status_code, {number_text(remove['status'])}, response.content)",
                get and f"        self.assertEqual(self.client.get({_url(get, resource)}).status_code, 404)",
            ],
        )
    for endpoint in resource["endpoints"]:
        if endpoint["operation"] != "custom":
            continue
        needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
        if (needs_item or endpoint["input"] == "resource") and not can_create:
            continue
        if endpoint["input"] == "none":
            payload = None
        elif endpoint["input"] == "partial":
            payload = "{}"
        else:
            payload = f"{one}_payload(self.client)"
        target = _url(endpoint, resource) if needs_item else py_string(fixed_path(endpoint, resource, "sample"))
        send = f', json.dumps({payload}), content_type="application/json"' if payload else ""
        test(
            f"{snake_words(endpoint['name'])}_is_pending",
            [
                needs_item
                and [f"        created = create_{one}(self.client)", f"        key = created[{py_string(key)}]"],
                "        # TODO: replace this test when the operation is written",
                f"        response = self.client.generic({py_string(endpoint['method'])}, {target}{send})",
                "        self.assertEqual(response.status_code, 501)",
            ],
        )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{snake_words(guarded['name'])}_needs_credentials",
            [
                "        self.client.credentials()",
                f"        response = self.client.get({py_string(fixed_path(guarded, resource, missing_key(resource)))})",
                "        self.assertEqual(response.status_code, 401)",
                '        self.assertEqual(response.json()["error"]["code"], "unauthorized")',
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        test(
            f"{snake_words(with_roles['name'])}_needs_a_role",
            [
                "        authorize(self.client, roles=[])",
                f"        response = self.client.get({py_string(fixed_path(with_roles, resource, missing_key(resource)))})",
                "        self.assertEqual(response.status_code, 403)",
            ],
        )
    body = "\n\n".join(tests)
    content = lines(
        f'"""Tests of the {resource["plural"]} endpoints."""',
        "",
        "json.dumps" in body and "import json",
        "@skip" in body and "from unittest import skip",
        "",
        "from rest_framework.test import APITestCase",
        "",
        f"from tests.helpers import {', '.join(sorted(helpers))}",
        "",
        "",
        "@TEST_SETTINGS",
        f"class {py_class(resource['plural'].replace(' ', '_'))}Tests(APITestCase):",
        '    """Every test starts with an empty database and a client allowed to call every endpoint."""',
        "",
        "    def setUp(self) -> None:",
        "        authorize(self.client)",
        "",
        body if body else "    def test_has_no_endpoints(self) -> None:\n        pass",
    )
    return {"path": f"tests/test_{name['many']}.py", "content": file_text(content)}


def test_files(context: DjangoContext) -> list[dict]:
    return [
        {"path": "tests/__init__.py", "content": ""},
        _helpers_file(context),
        *(_resource_tests(context, resource) for resource in context.spec["resources"]),
    ]
