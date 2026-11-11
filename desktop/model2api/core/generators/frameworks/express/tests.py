"""Tests of the Express project (Vitest + Supertest), and with another flavor of the NestJS project (Jest +
Supertest). They call every enabled endpoint the way a client would, with
the same cases as every other framework (common/testing.py). Mirrors
web/src/core/generators/frameworks/express/tests.ts.
"""

import re
from dataclasses import dataclass

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
from ...languages.typescript.typescript import ts_access, ts_doc, ts_literal, ts_string
from .context import names


@dataclass(frozen=True)
class TestFlavor:
    """What differs between the tests of the TypeScript frameworks: Express (Vitest) and NestJS (Jest)."""

    # Folder of the tests, and the extension of local imports
    folder: str
    local: str
    # The variable requests go to, its type, and the import of that type in the helpers
    client: str
    client_type: str
    client_import: str
    # How a status is expected (Vitest can show the response text)
    status: str
    # Imports of the helpers after supertest, and the first line of the setup
    helper_imports: tuple[str, ...]
    setup_first: tuple[str, ...]
    # Whether the setup always ends with export {}
    setup_export: bool
    # Imports, declarations and hooks of a test file, and its extension
    test_imports: tuple[str, ...]
    test_declarations: tuple[str, ...]
    test_hooks: tuple[str, ...]
    test_suffix: str


EXPRESS_FLAVOR = TestFlavor(
    folder="tests",
    local=".js",
    client="app",
    client_type="Express",
    client_import="import type { Express } from 'express'",
    status="expect(response.status, response.text)",
    helper_imports=("import { expect } from 'vitest'",),
    setup_first=(),
    setup_export=False,
    test_imports=(
        "import type { Express } from 'express'",
        "import request from 'supertest'",
        "import { beforeEach, describe, expect, it } from 'vitest'",
        "import { createApp } from '../src/app.js'",
    ),
    test_declarations=("  let app: Express",),
    test_hooks=("  beforeEach(() => {", "    app = createApp()", "  })"),
    test_suffix=".test.ts",
)


def url(endpoint: dict, resource: dict) -> str:
    """A template literal for a path whose key is the variable key."""
    return "`" + path_with_key(endpoint, resource).replace("{key}", "${key}", 1) + "`"


def subscript(path: list) -> str:
    return "".join(f"[{part if isinstance(part, int) else ts_string(part)}]" for part in path)


_VOWEL = re.compile(r"^[aeiou]", re.IGNORECASE)


def article(text: str) -> str:
    return f"an {text}" if _VOWEL.match(text) else f"a {text}"


def _helpers_file(context, flavor: TestFlavor) -> dict:
    spec = context.spec
    blocks: list[str] = []
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        name = names(resource)
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"  body{subscript(reference['path'])} = (await create{names(target)['type']}({flavor.client}, headers))"
                f"[{ts_string(key_wire(target))}]"
            )
        one = article(resource["singular"])
        blocks.append(
            lines(
                f"/** A valid body to create {one}, with the items it refers to created first. */",
                f"export async function {name['one']}Payload({flavor.client}: {flavor.client_type}, headers: Headers, variant = 0): Promise<Body> {{",
                f"  const body: Body = variant === 0 ? {ts_literal(first['body'])} : {ts_literal(second['body'])}",
                fills,
                "  return body",
                "}",
                "",
                f"/** Creates {one} and returns it as the API answers. */",
                f"export async function create{name['type']}({flavor.client}: {flavor.client_type}, headers: Headers, variant = 0): Promise<Body> {{",
                f"  const response = await request({flavor.client}).post({ts_string(create['path'])}).set(headers).send(await {name['one']}Payload({flavor.client}, headers, variant))",
                f"  {flavor.status}.toBe({number_text(create['status'])})",
                "  return response.body",
                "}",
            )
        )
    auth = context.settings["auth"]
    roles = ", ".join(map(ts_string, spec["roles"]))
    content = lines(
        ts_doc(
            "Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."
        ),
        "",
        flavor.client_import,
        auth == "jwt" and "import jwt from 'jsonwebtoken'",
        "import request from 'supertest'",
        list(flavor.helper_imports),
        "",
        "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
        "export type Body = Record<string, any>",
        "export type Headers = Record<string, string>",
        "",
        auth == "apiKey" and f"export const TEST_API_KEY = {ts_string(TEST_API_KEY)}",
        auth == "jwt"
        and [
            f"export const TEST_JWT_SECRET = {ts_string(TEST_JWT_SECRET)}",
            "",
            "/** A token signed with the test secret, valid for one hour. */",
            "export function token(roles: string[]): string {",
            "  return jwt.sign({ sub: 'tests', roles }, TEST_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' })",
            "}",
        ],
        "",
        "/** Headers of a client allowed to call every endpoint. */",
        auth == "none" and "export const headers: Headers = {}",
        auth == "apiKey" and "export const headers: Headers = { 'X-API-Key': TEST_API_KEY }",
        auth == "jwt"
        and [
            "export const headers: Headers = { Authorization: `Bearer ${token([" + roles + "])}` }",
            "",
            "/** Headers of a client with a valid token but no role. */",
            "export const headersWithoutRoles: Headers = { Authorization: `Bearer ${token([])}` }",
        ],
        "",
        "\n\n".join(blocks),
    )
    return {"path": f"{flavor.folder}/helpers.ts", "content": file_text(content)}


def _setup_file(context, flavor: TestFlavor) -> dict:
    auth = context.settings["auth"]
    content = lines(
        ts_doc("Test environment: the credentials the API accepts while the tests run."),
        "",
        list(flavor.setup_first),
        auth == "apiKey"
        and [f"import {{ TEST_API_KEY }} from './helpers{flavor.local}'", "", "process.env.API_KEYS = TEST_API_KEY"],
        auth == "jwt"
        and [
            f"import {{ TEST_JWT_SECRET }} from './helpers{flavor.local}'",
            "",
            "process.env.JWT_SECRET = TEST_JWT_SECRET",
            "delete process.env.JWT_AUDIENCE",
            "delete process.env.JWT_ISSUER",
        ],
        "export {}" if flavor.setup_export else auth == "none" and "export {}",
    )
    return {"path": f"{flavor.folder}/setup.ts", "content": file_text(content)}


def _words(name: str) -> str:
    return snake_words(name).replace("_", " ")


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")


def _resource_tests(context, resource: dict, flavor: TestFlavor) -> dict:
    spec = context.spec
    name = names(resource)
    type_name = name["type"]
    payload_of = f"{name['one']}Payload"
    key = key_wire(resource)
    tests: list[str] = []
    used = {"headers"}
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    one = article(resource["singular"])

    def test(title: str, body: list) -> None:
        tests.append(lines(f"  it({ts_string(title)}, async () => {{", *body, "  })"))

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            test(
                f"{_words(endpoint['name'])} answers 501 until the storage is written",
                [
                    f"    const response = await request({flavor.client}).get({ts_string(fixed_path(endpoint, resource, missing_key(resource)))}).set(headers)",
                    "    expect(response.status).toBe(501)",
                    "    expect(response.body.error.code).toBe('not_implemented')",
                ],
            )
    else:
        if create and not can_create:
            todo = problem if problem is not None else "write a body with the items it refers to"
            tests.append(lines(f"  it.skip({ts_string('creates ' + one)}, () => {{", f"    // TODO: {todo}", "  })"))
        if can_create:
            used.add(f"create{type_name}")
            used.add(payload_of)
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {one}",
                [
                    f"    const payload = await {payload_of}({flavor.client}, headers)",
                    f"    const response = await request({flavor.client}).post({ts_string(create['path'])}).set(headers).send(payload)",
                    f"    {flavor.status}.toBe({number_text(create['status'])})",
                    f"    expect({ts_access('response.body', key)}).toBeDefined()",
                    [
                        f"    expect({ts_access('response.body', wire)}).toEqual({ts_access('payload', wire)})"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                test(
                    f"rejects {one} without {required['wire']}",
                    [
                        f"    const payload = await {payload_of}({flavor.client}, headers)",
                        f"    delete payload[{ts_string(required['wire'])}]",
                        f"    const response = await request({flavor.client}).post({ts_string(create['path'])}).set(headers).send(payload)",
                        "    expect(response.status).toBe(400)",
                        "    expect(response.body.error.code).toBe('validation_error')",
                        f"    expect(response.body.error.details.some((detail: {{ field: string }}) => detail.field === {ts_string(required['wire'])})).toBe(true)",
                    ],
                )
            if resource["key"]["generated"] is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"    const created = await create{type_name}({flavor.client}, headers)",
                        f"    const payload = await {payload_of}({flavor.client}, headers)",
                        f"    payload[{ts_string(key)}] = created[{ts_string(key)}]",
                        f"    const response = await request({flavor.client}).post({ts_string(create['path'])}).set(headers).send(payload)",
                        "    expect(response.status).toBe(409)",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {one}",
                    [
                        f"    const created = await create{type_name}({flavor.client}, headers)",
                        f"    const key = created[{ts_string(key)}]",
                        f"    const response = await request({flavor.client}).get({url(get, resource)}).set(headers)",
                        f"    {flavor.status}.toBe(200)",
                        "    expect(response.body).toEqual(created)",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"    const response = await request({flavor.client}).get({ts_string(fixed_path(get, resource, missing_key(resource)))}).set(headers)",
                    "    expect(response.status).toBe(404)",
                    "    expect(response.body.error.code).toBe('not_found')",
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"    await create{type_name}({flavor.client}, headers)",
                    can_create and distinct and f"    await create{type_name}({flavor.client}, headers, 1)",
                    f"    const response = await request({flavor.client}).get({ts_string(listing['path'])}).set(headers)",
                    f"    {flavor.status}.toBe(200)",
                    [f"    expect(response.body.total).toBe({count})", "    expect(response.body.page).toBe(1)"]
                    if listing["pagination"]
                    else f"    expect(response.body).toHaveLength({count})",
                ],
            )
            if listing["pagination"] and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"    await create{type_name}({flavor.client}, headers)",
                        f"    await create{type_name}({flavor.client}, headers, 1)",
                        f"    const response = await request({flavor.client}).get({ts_string(listing['path'])}).query({{ page: 2, size: 1 }}).set(headers)",
                        f"    {flavor.status}.toBe(200)",
                        "    expect(response.body.total).toBe(2)",
                        "    expect(response.body.items).toHaveLength(1)",
                        "    expect(response.body.page).toBe(2)",
                    ],
                )
            if listing["pagination"]:
                test(
                    "rejects a page that does not exist",
                    [
                        f"    const response = await request({flavor.client}).get({ts_string(listing['path'])}).query({{ page: 0 }}).set(headers)",
                        "    expect(response.status).toBe(400)",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            second = sample_body(spec, resource, 1)["sample"]["body"]
            test(
                f"replaces {one}",
                [
                    f"    const created = await create{type_name}({flavor.client}, headers)",
                    f"    const key = created[{ts_string(key)}]",
                    f"    const payload = await {payload_of}({flavor.client}, headers, 1)",
                    resource["key"]["generated"] is None and f"    payload[{ts_string(key)}] = key",
                    f"    const response = await request({flavor.client}).put({url(replace, resource)}).set(headers).send(payload)",
                    f"    {flavor.status}.toBe(200)",
                    [
                        f"    expect({ts_access('response.body', wire)}).toEqual({ts_access('payload', wire)})"
                        for wire in comparable_fields(resource, second)
                        if wire != key
                    ],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            test(
                f"updates part of {one}",
                [
                    f"    const created = await create{type_name}({flavor.client}, headers)",
                    f"    const key = created[{ts_string(key)}]",
                    f"    const response = await request({flavor.client}).patch({url(update, resource)}).set(headers).send({{ {ts_string(field['wire'])}: {ts_literal(value)} }})",
                    f"    {flavor.status}.toBe(200)",
                    f"    expect({ts_access('response.body', field['wire'])}).toEqual({ts_literal(value)})",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        f"    const created = await create{type_name}({flavor.client}, headers)",
                        f"    const key = created[{ts_string(key)}]",
                        f"    const response = await request({flavor.client}).patch({url(update, resource)}).set(headers).send({{ {ts_string(field['wire'])}: null }})",
                        "    expect(response.status).toBe(400)",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {one}",
                [
                    f"    const created = await create{type_name}({flavor.client}, headers)",
                    f"    const key = created[{ts_string(key)}]",
                    f"    const response = await request({flavor.client}).delete({url(remove, resource)}).set(headers)",
                    f"    {flavor.status}.toBe({number_text(remove['status'])})",
                    get
                    and f"    expect((await request({flavor.client}).get({url(get, resource)}).set(headers)).status).toBe(404)",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            if endpoint["input"] == "none":
                send = ""
            elif endpoint["input"] == "partial":
                send = ".send({})"
            else:
                send = f".send(await {payload_of}({flavor.client}, headers))"
            target = url(endpoint, resource) if needs_item else ts_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{_words(endpoint['name'])} answers 501 until it is written",
                [
                    needs_item
                    and [
                        f"    const created = await create{type_name}({flavor.client}, headers)",
                        f"    const key = created[{ts_string(key)}]",
                    ],
                    f"    const response = await request({flavor.client}).{endpoint['method'].lower()}({target}).set(headers){send}",
                    "    // TODO: replace this test when the operation is written",
                    "    expect(response.status).toBe(501)",
                ],
            )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{_words(guarded['name'])} needs credentials",
            [
                f"    const response = await request({flavor.client}).get({ts_string(fixed_path(guarded, resource, missing_key(resource)))})",
                "    expect(response.status).toBe(401)",
                "    expect(response.body.error.code).toBe('unauthorized')",
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        used.add("headersWithoutRoles")
        test(
            f"{_words(with_roles['name'])} needs a role",
            [
                f"    const response = await request({flavor.client}).get({ts_string(fixed_path(with_roles, resource, missing_key(resource)))}).set(headersWithoutRoles)",
                "    expect(response.status).toBe(403)",
            ],
        )
    content = lines(
        ts_doc(f"Tests of the {resource['plural']} endpoints."),
        "",
        list(flavor.test_imports),
        f"import {{ {', '.join(sorted(used))} }} from './helpers{flavor.local}'",
        "",
        f"describe({ts_string(resource['plural'])}, () => {{",
        list(flavor.test_declarations),
        "",
        "  // A new application per test: every test starts with empty storage",
        list(flavor.test_hooks),
        "",
        "\n\n".join(tests) if tests else "  it('has no endpoints', () => {})",
        "})",
    )
    file_name = _CAMEL.sub(r"\1-\2", name["many"]).lower()
    return {"path": f"{flavor.folder}/{file_name}{flavor.test_suffix}", "content": file_text(content)}


def test_files(context, flavor: TestFlavor = EXPRESS_FLAVOR) -> list[dict]:
    """The test files of a TypeScript project: Express by default, NestJS with its flavor."""
    return [
        _setup_file(context, flavor),
        _helpers_file(context, flavor),
        *(_resource_tests(context, resource, flavor) for resource in context.spec["resources"]),
    ]
