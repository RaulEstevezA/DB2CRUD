"""Tests of a PHP project (Laravel and Symfony) with PHPUnit. They call every enabled endpoint the way a client
would, with the same cases as every other framework (common/testing.py), through the helpers each framework's base
test class gives: postJson, getJson, putJson, patchJson, deleteJson and json, answering with assertStatus and
json(path). Each test runs on a new application, so it starts with empty storage. Mirrors
web/src/core/generators/languages/php/tests.ts.
"""

import re

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
)
from ...common.text import compare_key, file_text, lines
from .php import php_doc, php_literal, php_string
from .project import article, resource_names


def _short(name: str) -> str:
    """The class of a fully qualified name."""
    return name[name.rfind("\\") + 1 :]


def _namespace_of(name: str) -> str:
    return name[: name.rfind("\\")]


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NOT_WORD = re.compile(r"[^a-z0-9]+")
_EDGES = re.compile(r"^_+|_+$")


def _url(endpoint: dict, resource: dict) -> str:
    """A PHP expression for a path whose key is the variable $key."""
    parts = path_with_key(endpoint, resource).split("{key}")
    if len(parts) == 1:
        return php_string(parts[0])
    after = parts[1]
    return f"{php_string(parts[0])}.$key{f'.{php_string(after)}' if after else ''}"


def _subscript(path: list) -> str:
    return "".join(f"[{part}]" if isinstance(part, int) else f"[{php_string(part)}]" for part in path)


def _method_name(title: str) -> str:
    """A test method name from its title: creates a customer → test_creates_a_customer."""
    words = _NOT_WORD.sub("_", _CAMEL.sub(r"\1_\2", title).lower())
    return f"test_{_EDGES.sub('', words)}"


def test_data_file(context) -> dict:
    auth = context.settings["auth"]
    spec = context.spec
    blocks: list[str] = []
    for resource in spec["resources"]:
        if not creatable(spec, resource):
            continue
        name = resource_names(resource)
        create = find_endpoint(resource, "create")
        first = sample_body(spec, resource, 0)["sample"]
        second = sample_body(spec, resource, 1)["sample"]
        fills = []
        for reference in first["references"]:
            target = next(item for item in spec["resources"] if item["name"] == reference["resource"])
            fills.append(
                f"        $body{_subscript(reference['path'])} = $this->create{resource_names(target)['type']}()[{php_string(key_wire(target))}];"
            )
        blocks.append(
            lines(
                "    /**",
                f"     * A valid body to create {article(resource['singular'])}, with the items it refers to created first.",
                "     *",
                "     * @return array<string, mixed>",
                "     */",
                f"    protected function {name['one']}Payload(int $variant = 0): array",
                "    {",
                f"        $body = $variant === 0 ? {php_literal(first['body'])} : {php_literal(second['body'])};",
                fills,
                "",
                "        return $body;",
                "    }",
                "",
                "    /**",
                f"     * Creates {article(resource['singular'])} and returns it as the API answers.",
                "     *",
                "     * @return array<string, mixed>",
                "     */",
                f"    protected function create{name['type']}(int $variant = 0): array",
                "    {",
                f"        $response = $this->postJson({php_string(create['path'])}, $this->{name['one']}Payload($variant), $this->headers());",
                f"        $response->assertStatus({create['status']});",
                "",
                "        return $response->json();",
                "    }",
            )
        )
    roles = ", ".join(php_string(role) for role in spec["roles"])
    content = lines(
        "<?php",
        "",
        f"namespace {_namespace_of(context.tests['data'])};",
        "",
        auth == "jwt" and ["use Firebase\\JWT\\JWT;", ""],
        php_doc(
            "Credentials for the tests, builders of valid request bodies, and helpers that create items through the API."
        ),
        f"trait {_short(context.tests['data'])}",
        "{",
        "    /** @return array<string, string> Headers of a client allowed to call every endpoint. */",
        "    protected function headers(): array",
        "    {",
        auth == "none" and "        return [];",
        auth == "apiKey" and f"        return ['X-API-Key' => {php_string(TEST_API_KEY)}];",
        auth == "jwt" and f"        return ['Authorization' => 'Bearer '.$this->token([{roles}])];",
        "    }",
        auth == "jwt"
        and [
            "",
            "    /** @return array<string, string> Headers of a client with a valid token but no role. */",
            "    protected function headersWithoutRoles(): array",
            "    {",
            "        return ['Authorization' => 'Bearer '.$this->token([])];",
            "    }",
            "",
            "    /**",
            "     * A token signed with the test secret (phpunit.xml), valid for one hour.",
            "     *",
            "     * @param  list<string>  $roles",
            "     */",
            "    protected function token(array $roles): string",
            "    {",
            f"        return JWT::encode(['sub' => 'tests', 'roles' => $roles, 'exp' => time() + 3600], {php_string(TEST_JWT_SECRET)}, 'HS256');",
            "    }",
        ],
        bool(blocks) and ["", "\n\n".join(blocks)],
        "}",
    )
    return {"path": context.tests["dataPath"], "content": file_text(content)}


def resource_test_file(context, resource: dict) -> dict:
    spec = context.spec
    name = resource_names(resource)
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    used: set[str] = set()

    def test(title: str, body: list) -> None:
        method = _method_name(title)
        n = 2
        while method in used:
            method = f"{_method_name(title)}_{n}"
            n += 1
        used.add(method)
        tests.append(lines(f"    public function {method}(): void", "    {", *body, "    }"))

    created_key = [f"        $created = $this->create{name['type']}();", f"        $key = $created[{php_string(key)}];"]
    headers = "$this->headers()"

    if context.pending:
        for endpoint in (item for item in (listing, get) if item):
            test(
                f"{endpoint['name']} answers 501 until the storage is written",
                [
                    f"        $response = $this->getJson({php_string(fixed_path(endpoint, resource, missing_key(resource)))}, {headers});",
                    "",
                    "        $response->assertStatus(501);",
                    "        $this->assertSame('not_implemented', $response->json('error.code'));",
                ],
            )
    else:
        if create and not can_create:
            reason = problem if problem is not None else "An item it refers to cannot be created through the API."
            todo = problem if problem is not None else "write a body with the items it refers to"
            test(
                f"creates {article(resource['singular'])}",
                [f"        // TODO: {todo}", f"        $this->markTestSkipped({php_string(reason)});"],
            )
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {article(resource['singular'])}",
                [
                    f"        $payload = $this->{name['one']}Payload();",
                    "",
                    f"        $response = $this->postJson({php_string(create['path'])}, $payload, {headers});",
                    "",
                    f"        $response->assertStatus({create['status']});",
                    "        $body = $response->json();",
                    f"        $this->assertArrayHasKey({php_string(key)}, $body);",
                    [
                        f"        $this->assertSame($payload[{php_string(wire)}], $body[{php_string(wire)}]);"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                test(
                    f"rejects {article(resource['singular'])} without {required['wire']}",
                    [
                        f"        $payload = $this->{name['one']}Payload();",
                        f"        unset($payload[{php_string(required['wire'])}]);",
                        "",
                        f"        $response = $this->postJson({php_string(create['path'])}, $payload, {headers});",
                        "",
                        "        $response->assertStatus(400);",
                        "        $this->assertSame('validation_error', $response->json('error.code'));",
                        f"        $this->assertContains({php_string(required['wire'])}, array_column($response->json('error.details'), 'field'));",
                    ],
                )
            if resource["key"].get("generated") is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"        $created = $this->create{name['type']}();",
                        f"        $payload = $this->{name['one']}Payload();",
                        f"        $payload[{php_string(key)}] = $created[{php_string(key)}];",
                        "",
                        f"        $response = $this->postJson({php_string(create['path'])}, $payload, {headers});",
                        "",
                        "        $response->assertStatus(409);",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {article(resource['singular'])}",
                    [
                        *created_key,
                        "",
                        f"        $response = $this->getJson({_url(get, resource)}, {headers});",
                        "",
                        "        $response->assertStatus(200);",
                        "        $this->assertEquals($created, $response->json());",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"        $response = $this->getJson({php_string(fixed_path(get, resource, missing_key(resource)))}, {headers});",
                    "",
                    "        $response->assertStatus(404);",
                    "        $this->assertSame('not_found', $response->json('error.code'));",
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"        $this->create{name['type']}();",
                    can_create and distinct and f"        $this->create{name['type']}(1);",
                    "",
                    f"        $response = $this->getJson({php_string(listing['path'])}, {headers});",
                    "",
                    "        $response->assertStatus(200);",
                    [
                        f"        $this->assertSame({count}, $response->json('total'));",
                        "        $this->assertSame(1, $response->json('page'));",
                    ]
                    if listing.get("pagination")
                    else f"        $this->assertCount({count}, $response->json());",
                ],
            )
            if listing.get("pagination") and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"        $this->create{name['type']}();",
                        f"        $this->create{name['type']}(1);",
                        "",
                        f"        $response = $this->getJson({php_string(listing['path'] + '?page=2&size=1')}, {headers});",
                        "",
                        "        $response->assertStatus(200);",
                        "        $this->assertSame(2, $response->json('total'));",
                        "        $this->assertCount(1, $response->json('items'));",
                        "        $this->assertSame(2, $response->json('page'));",
                    ],
                )
            if listing.get("pagination"):
                test(
                    "rejects a page that does not exist",
                    [
                        f"        $response = $this->getJson({php_string(listing['path'] + '?page=0')}, {headers});",
                        "",
                        "        $response->assertStatus(400);",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            second_body = sample_body(spec, resource, 1)["sample"]["body"]
            test(
                f"replaces {article(resource['singular'])}",
                [
                    *created_key,
                    f"        $payload = $this->{name['one']}Payload(1);",
                    resource["key"].get("generated") is None and f"        $payload[{php_string(key)}] = $key;",
                    "",
                    f"        $response = $this->putJson({_url(replace, resource)}, $payload, {headers});",
                    "",
                    "        $response->assertStatus(200);",
                    [
                        f"        $this->assertSame($payload[{php_string(wire)}], $response->json()[{php_string(wire)}]);"
                        for wire in comparable_fields(resource, second_body)
                        if wire != key
                    ],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            wire = php_string(field["wire"])
            test(
                f"updates part of {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        $response = $this->patchJson({_url(update, resource)}, [{wire} => {php_literal(value)}], {headers});",
                    "",
                    "        $response->assertStatus(200);",
                    f"        $this->assertEquals({php_literal(value)}, $response->json()[{wire}]);",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        *created_key,
                        "",
                        f"        $response = $this->patchJson({_url(update, resource)}, [{wire} => null], {headers});",
                        "",
                        "        $response->assertStatus(400);",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        $response = $this->deleteJson({_url(remove, resource)}, [], {headers});",
                    "",
                    f"        $response->assertStatus({remove['status']});",
                    get and f"        $this->getJson({_url(get, resource)}, {headers})->assertStatus(404);",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            body = f"$this->{name['one']}Payload()" if endpoint["input"] == "resource" else "[]"
            path = _url(endpoint, resource) if needs_item else php_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{endpoint['name']} answers 501 until it is written",
                [
                    needs_item and created_key,
                    "        // TODO: replace this test when the operation is written",
                    f"        $response = $this->json({php_string(endpoint['method'])}, {path}, {body}, {headers});",
                    "",
                    "        $response->assertStatus(501);",
                ],
            )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{guarded['name']} needs credentials",
            [
                f"        $response = $this->getJson({php_string(fixed_path(guarded, resource, missing_key(resource)))});",
                "",
                "        $response->assertStatus(401);",
                "        $this->assertSame('unauthorized', $response->json('error.code'));",
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        test(
            f"{with_roles['name']} needs a role",
            [
                f"        $response = $this->getJson({php_string(fixed_path(with_roles, resource, missing_key(resource)))}, $this->headersWithoutRoles());",
                "",
                "        $response->assertStatus(403);",
            ],
        )
    class_name = f"{name['type']}ApiTest"
    content = lines(
        "<?php",
        "",
        f"namespace {context.tests['namespace']};",
        "",
        [f"use {name};" for name in sorted([context.tests["base"], context.tests["data"]], key=compare_key)],
        "",
        php_doc(f"Tests of the {resource['plural']} endpoints."),
        f"final class {class_name} extends {_short(context.tests['base'])}",
        "{",
        f"    use {_short(context.tests['data'])};",
        "",
        "\n\n".join(tests)
        if tests
        else [
            "    public function test_has_no_endpoints(): void",
            "    {",
            "        $this->assertTrue(true);",
            "    }",
        ],
        "}",
    )
    return {"path": f"{context.tests['folder']}/{class_name}.php", "content": file_text(content)}
