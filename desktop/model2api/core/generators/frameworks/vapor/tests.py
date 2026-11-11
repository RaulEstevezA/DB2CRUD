"""Tests of the Vapor project (Swift Testing with VaporTesting, in Tests/AppTests/). They call every enabled endpoint
through the app, the way a client would, with the same cases as every other framework (common/testing.py). Each test
builds the application anew, so it starts with empty storage and can count items exactly. Mirrors
web/src/core/generators/frameworks/vapor/tests.ts.
"""

import re

from ....js import number_text
from ...common.samples import json_text, sample_body, updatable_field
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
from ...common.text import file_text, lines
from ...languages.swift.swift import sw_doc, sw_header, sw_string
from . import swift_blocks
from .common import block
from .context import VaporContext, article, names


def _url(endpoint: dict, resource: dict) -> str:
    """A Swift expression for a path whose key is the variable key."""
    return sw_string(path_with_key(endpoint, resource)).replace("{key}", "\\(key)", 1)


def _pointer(path: list) -> str:
    """A JSON pointer to a place in a body: /lines/0/productId."""
    return "".join(
        "/" + (number_text(part) if isinstance(part, (int, float)) else part).replace("~", "~0").replace("/", "~1")
        for part in path
    )


def _json(value) -> str:
    """A JSON value written in Swift: parsed from its text."""
    return f"parse({sw_string(json_text(value))})"


_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_SEPARATORS = re.compile(r"[^A-Za-z0-9]+")


def _test_name(title: str) -> str:
    """A Swift function name from a test title."""
    words = [word for word in _SEPARATORS.split(_CAMEL.sub(r"\1 \2", title)) if word]
    name = "".join(
        word.lower() if index == 0 else word[:1].upper() + word[1:].lower() for index, word in enumerate(words)
    )
    if re.match(r"^[0-9]", name):
        return f"test{name}"
    return name or "test"


def _support_file(context: VaporContext) -> dict:
    """The base of the tests: a new application for each test, the client, credentials and builders of valid bodies."""
    auth = context.settings["auth"]
    spec = context.spec
    imports = ["App", "Foundation", "Testing", "VaporTesting"]
    if auth == "jwt":
        imports.append("JWT")
    configures = [
        context.fluent and '    let shared = ProcessInfo.processInfo.environment["TEST_DATABASE_URL"] ?? ""',
        auth == "apiKey" and "    settings.apiKeys = [testAPIKey]",
        auth == "jwt" and "    settings.jwtSecret = testJWTSecret",
        context.fluent
        and [
            "    // TEST_DATABASE_URL runs the tests on that database, emptied first; without it, each test has its own SQLite file",
            '    settings.databaseURL = shared.isEmpty ? "sqlite://\\(NSTemporaryDirectory())api-test-\\(UUID().uuidString).db" : shared',
            "    if !shared.isEmpty {",
            "        await TestLock.shared.acquire()",
            "    }",
        ],
    ]
    mutates = context.fluent or auth != "none"
    with_api = [
        sw_doc("Runs a test on a new application, so each one starts with empty storage."),
        "func withApi(_ test: (Api) async throws -> Void) async throws {",
        f"    {'var' if mutates else 'let'} settings = Settings()",
        configures,
        "    let app = try await Application.make(.testing)",
        "    do {",
        "        try await configure(app, settings: settings)",
        context.fluent
        and [
            "        if !shared.isEmpty {",
            "            try await app.autoRevert()",
            "            try await app.autoMigrate()",
            "        }",
        ],
        "        try await test(Api(app: app))",
        "    } catch {",
        "        try? await app.asyncShutdown()",
        context.fluent and "        if !shared.isEmpty { await TestLock.shared.release() }",
        "        throw error",
        "    }",
        "    try await app.asyncShutdown()",
        context.fluent and "    if !shared.isEmpty { await TestLock.shared.release() }",
        "}",
    ]
    if auth == "none":
        headers = ["func headers() async throws -> HTTPHeaders {", "    HTTPHeaders()", "}"]
    elif auth == "apiKey":
        headers = ["func headers() async throws -> HTTPHeaders {", '    ["x-api-key": testAPIKey]', "}"]
    else:
        roles = ", ".join(sw_string(role) for role in spec["roles"])
        headers = [
            "func headers() async throws -> HTTPHeaders {",
            f'    ["authorization": "Bearer \\(try await token([{roles}]))"]',
            "}",
            "",
            sw_doc("Headers of a client with a valid token but no role."),
            "func headersWithoutRoles() async throws -> HTTPHeaders {",
            '    ["authorization": "Bearer \\(try await token([]))"]',
            "}",
            "",
            sw_doc("A token signed with the test secret, valid for one hour."),
            "func token(_ roles: [String]) async throws -> String {",
            "    let keys = JWTKeyCollection()",
            "    await keys.add(hmac: HMACKey(from: testJWTSecret), digestAlgorithm: .sha256)",
            "    return try await keys.sign(Claims(exp: ExpirationClaim(value: Date().addingTimeInterval(3600)), roles: roles))",
            "}",
        ]
    builders: list[str] = []
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
                f"        body = with(body, {sw_string(_pointer(reference['path']))}, "
                f"try await create{names(target)['type']}()[{sw_string(key_wire(target))}])"
            )
        builders.append(
            lines(
                f"    /// A valid body to create {article(resource['singular'])}, with the items it refers to created first.",
                f"    func {name['one']}Payload(_ variant: Int = 0) async throws -> JSONValue {{",
                f"        {'var' if fills else 'let'} body = variant == 0 ? {_json(first['body'])} : {_json(second['body'])}",
                fills,
                "        return body",
                "    }",
                "",
                f"    /// Creates {article(resource['singular'])} and returns it as the API answers.",
                f"    func create{name['type']}(_ variant: Int = 0) async throws -> JSONValue {{",
                f"        let response = try await post({sw_string(create['path'])}, {name['one']}Payload(variant), headers())",
                f'        #expect(response.status == {number_text(create["status"])}, "\\(response.text)")',
                "        return response.json",
                "    }",
            )
        )
    content = lines(
        *sw_header("Base of the tests: a new application for each test, so each one starts with empty storage.", []),
        ["@testable import App" if item == "App" else f"import {item}" for item in imports],
        "",
        auth == "apiKey" and [f"let testAPIKey = {sw_string(TEST_API_KEY)}", ""],
        auth == "jwt" and [f"let testJWTSecret = {sw_string(TEST_JWT_SECRET)}", ""],
        context.fluent and [block(swift_blocks.SUPPORT), ""],
        with_api,
        "",
        sw_doc("Headers of a client allowed to call every endpoint."),
        headers,
        "",
        block(swift_blocks.CLIENT),
        bool(builders) and ["", "extension Api {", "\n\n".join(builders), "}"],
        "",
        block(swift_blocks.HELPERS),
    )
    return {"path": "Tests/AppTests/Support.swift", "content": file_text(content)}


def _expect_value(value, actual: str) -> str:
    """An expectation that a value of a JSON answer equals a sample value."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        text = number_text(value)
        return f"#expect({actual}.number == {text + '.0' if float(value).is_integer() else text})"
    return f"#expect({actual} == {_json(value)})"


def _resource_test_file(context: VaporContext, resource: dict) -> dict:
    spec = context.spec
    auth = context.settings["auth"]
    name = names(resource)
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    used: set[str] = set()

    def test(title: str, body: list, skip: str | None = None) -> None:
        fn = _test_name(title)
        n = 2
        while fn in used:
            fn = f"{_test_name(title)}{n}"
            n += 1
        used.add(fn)
        if skip:
            tests.append(
                lines(
                    f"    @Test({sw_string(title)}, .disabled({sw_string(skip)}))",
                    f"    func {fn}() {{",
                    *body,
                    "    }",
                )
            )
        else:
            tests.append(
                lines(
                    f"    @Test({sw_string(title)})",
                    f"    func {fn}() async throws {{",
                    "        try await withApi { api in",
                    *body,
                    "        }",
                    "    }",
                )
            )

    created_key = [
        f"            let created = try await api.create{name['type']}()",
        f"            let key = created[{sw_string(key)}].text",
    ]
    code = 'response.json["error"]["code"]'

    def status(expected) -> str:
        return f'            #expect(response.status == {number_text(expected)}, "\\(response.text)")'

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            test(
                f"{endpoint['name']} answers 501 until the storage is written",
                [
                    f"            let response = try await api.get({sw_string(fixed_path(endpoint, resource, missing_key(resource)))}, headers())",
                    "",
                    status(501),
                    f'            #expect({code} == .string("not_implemented"))',
                ],
            )
    else:
        if create and not can_create:
            test(
                f"creates {article(resource['singular'])}",
                [f"        // TODO: {problem or 'write a body with the items it refers to'}"],
                problem or "An item it refers to cannot be created through the API.",
            )
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {article(resource['singular'])}",
                [
                    f"            let payload = try await api.{name['one']}Payload()",
                    "",
                    f"            let response = try await api.post({sw_string(create['path'])}, payload, headers())",
                    "",
                    status(create["status"]),
                    f"            #expect(response.json.has({sw_string(key)}))",
                    [
                        f"            #expect(payload[{sw_string(wire)}] == response.json[{sw_string(wire)}])"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                wire = sw_string(required["wire"])
                test(
                    f"rejects {article(resource['singular'])} without {required['wire']}",
                    [
                        f"            let payload = without(try await api.{name['one']}Payload(), {wire})",
                        "",
                        f"            let response = try await api.post({sw_string(create['path'])}, payload, headers())",
                        "",
                        status(400),
                        f'            #expect({code} == .string("validation_error"))',
                        '            guard case .array(let details) = response.json["error"]["details"] else {',
                        '                Issue.record("The error has no details")',
                        "                return",
                        "            }",
                        f'            #expect(details.contains {{ $0["field"] == .string({wire}) }})',
                    ],
                )
            if resource["key"]["generated"] is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"            let created = try await api.create{name['type']}()",
                        f"            let payload = with(try await api.{name['one']}Payload(), {sw_string(_pointer([key]))}, created[{sw_string(key)}])",
                        "",
                        f"            let response = try await api.post({sw_string(create['path'])}, payload, headers())",
                        "",
                        status(409),
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {article(resource['singular'])}",
                    [
                        *created_key,
                        "",
                        f"            let response = try await api.get({_url(get, resource)}, headers())",
                        "",
                        status(200),
                        "            #expect(created == response.json)",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"            let response = try await api.get({sw_string(fixed_path(get, resource, missing_key(resource)))}, headers())",
                    "",
                    status(404),
                    f'            #expect({code} == .string("not_found"))',
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"            _ = try await api.create{name['type']}()",
                    can_create and distinct and f"            _ = try await api.create{name['type']}(1)",
                    "",
                    f"            let response = try await api.get({sw_string(listing['path'])}, headers())",
                    "",
                    status(200),
                    [
                        f'            #expect(response.json["total"] == .number({count}))',
                        '            #expect(response.json["page"] == .number(1))',
                    ]
                    if listing["pagination"]
                    else f"            #expect(response.json.count == {count})",
                ],
            )
            if listing["pagination"] and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"            _ = try await api.create{name['type']}()",
                        f"            _ = try await api.create{name['type']}(1)",
                        "",
                        f"            let response = try await api.get({sw_string(listing['path'] + '?page=2&size=1')}, headers())",
                        "",
                        status(200),
                        '            #expect(response.json["total"] == .number(2))',
                        '            #expect(response.json["items"].count == 1)',
                        '            #expect(response.json["page"] == .number(2))',
                    ],
                )
            if listing["pagination"]:
                test(
                    "rejects a page that does not exist",
                    [
                        f"            let response = try await api.get({sw_string(listing['path'] + '?page=0')}, headers())",
                        "",
                        status(400),
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            compared = [
                wire
                for wire in comparable_fields(resource, sample_body(spec, resource, 1)["sample"]["body"])
                if wire != key
            ]
            test(
                f"replaces {article(resource['singular'])}",
                [
                    *created_key,
                    f"            let payload = with(try await api.{name['one']}Payload(1), {sw_string(_pointer([key]))}, created[{sw_string(key)}])"
                    if resource["key"]["generated"] is None
                    else f"            let payload = try await api.{name['one']}Payload(1)",
                    "",
                    f"            let response = try await api.put({_url(replace, resource)}, payload, headers())",
                    "",
                    status(200),
                    [
                        f"            #expect(payload[{sw_string(wire)}] == response.json[{sw_string(wire)}])"
                        for wire in compared
                    ],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            actual = f"response.json[{sw_string(field['wire'])}]"
            test(
                f"updates part of {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"            let response = try await api.patch({_url(update, resource)}, {_json({field['wire']: value})}, headers())",
                    "",
                    status(200),
                    f"            {_expect_value(value, actual)}",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        *created_key,
                        "",
                        f"            let response = try await api.patch({_url(update, resource)}, {_json({field['wire']: None})}, headers())",
                        "",
                        status(400),
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"            let response = try await api.delete({_url(remove, resource)}, headers())",
                    "",
                    status(remove["status"]),
                    get and f"            #expect(try await api.get({_url(get, resource)}, headers()).status == 404)",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            if endpoint["input"] == "none":
                body = "nil"
            elif endpoint["input"] == "partial":
                body = 'parse("{}")'
            else:
                body = f"try await api.{name['one']}Payload()"
            path = _url(endpoint, resource) if needs_item else sw_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{endpoint['name']} answers 501 until it is written",
                [
                    needs_item and created_key,
                    "            // TODO: replace this test when the operation is written",
                    f"            let response = try await api.send(.{endpoint['method']}, {path}, {body}, headers())",
                    "",
                    status(501),
                ],
            )
    guarded = protected_endpoint(resource, auth)
    if guarded:
        test(
            f"{guarded['name']} needs credentials",
            [
                f"            let response = try await api.get({sw_string(fixed_path(guarded, resource, missing_key(resource)))}, HTTPHeaders())",
                "",
                status(401),
                f'            #expect({code} == .string("unauthorized"))',
            ],
        )
    with_roles = role_endpoint(resource, auth)
    if with_roles:
        test(
            f"{with_roles['name']} needs a role",
            [
                f"            let response = try await api.get({sw_string(fixed_path(with_roles, resource, missing_key(resource)))}, headersWithoutRoles())",
                "",
                status(403),
            ],
        )
    content = lines(
        *sw_header(f"Tests of the {resource['plural']} endpoints.", []),
        "@testable import App",
        "import Testing",
        "import VaporTesting",
        "",
        f"@Suite({sw_string(name['plural'] + ' API')})",
        f"struct {name['tests']} {{",
        "\n\n".join(tests) if tests else ['    @Test("has no endpoints")', "    func hasNoEndpoints() {}"],
        "}",
    )
    return {"path": f"Tests/AppTests/{name['tests']}.swift", "content": file_text(content)}


def test_files(context: VaporContext) -> list[dict]:
    return [_support_file(context), *(_resource_test_file(context, resource) for resource in context.spec["resources"])]
