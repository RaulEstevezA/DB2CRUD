"""Tests of the Ktor project (kotlin.test on JUnit 5, with ktor-server-test-host). They call every enabled endpoint the
way a client would, with the same cases as every other framework (common/testing.py). Each test starts the
application anew, so it starts with empty storage and can count items exactly. Mirrors
web/src/core/generators/frameworks/ktor/tests.ts.
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
from ...languages.kotlin.kotlin import KtImports, kt_doc, kt_header, kt_string
from .context import KtorContext, article, common_package, names, source_path


def _url(endpoint: dict, resource: dict) -> str:
    """A Kotlin expression for a path whose key is the variable key."""
    parts = path_with_key(endpoint, resource).split("{key}")
    if len(parts) == 1:
        return kt_string(parts[0])
    return " + ".join(item for item in (kt_string(parts[0]), "key", kt_string(parts[1]) if parts[1] else None) if item)


def _path_list(path: list) -> str:
    """A path in a body for with: listOf("lines", 0, "productId")."""
    return f"listOf({', '.join(str(part) if isinstance(part, int) else kt_string(part) for part in path)})"


def _json(value) -> str:
    """A JSON value written in Kotlin: parsed from its text."""
    return f"Json.parseToJsonElement({kt_string(json_text(value))})"


_NOT_ALLOWED = re.compile(r"[^A-Za-z0-9 _-]+")
_SPACES = re.compile(r"\s+")


def _test_name(title: str) -> str:
    """A test name from its title, as Kotlin writes it between backticks."""
    return _SPACES.sub(" ", _NOT_ALLOWED.sub(" ", title)).strip()


def _api_test_file(context: KtorContext) -> dict:
    """The base of the tests: a new application for each test, the client helpers and the JSON helpers."""
    package = context.base
    imports = KtImports(package).add(
        "io.ktor.client.HttpClient",
        "io.ktor.client.request.header",
        "io.ktor.client.request.request",
        "io.ktor.client.request.setBody",
        "io.ktor.client.statement.bodyAsText",
        "io.ktor.http.ContentType",
        "io.ktor.http.HttpMethod",
        "io.ktor.http.contentType",
        "io.ktor.server.testing.testApplication",
        "kotlinx.serialization.json.Json",
        "kotlinx.serialization.json.JsonArray",
        "kotlinx.serialization.json.JsonElement",
        "kotlinx.serialization.json.JsonObject",
        "kotlinx.serialization.json.jsonArray",
        "kotlinx.serialization.json.jsonObject",
        "kotlin.test.assertEquals",
    )
    content = lines(
        *kt_header(package, imports),
        kt_doc("Base of the tests: a new application for each test, so each one starts with empty storage."),
        "abstract class ApiTest {",
        "    protected fun api(test: suspend Api.() -> Unit) = testApplication {",
        "        application { module(testSettings()) }",
        "        Api(client).test()",
        "    }",
        "}",
        "",
        kt_doc("Calls the application under test with JSON."),
        "class Api(private val client: HttpClient) {",
        "    suspend fun get(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Get, path, null, headers)",
        "",
        "    suspend fun post(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =",
        "        send(HttpMethod.Post, path, body, headers)",
        "",
        "    suspend fun put(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =",
        "        send(HttpMethod.Put, path, body, headers)",
        "",
        "    suspend fun patch(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =",
        "        send(HttpMethod.Patch, path, body, headers)",
        "",
        "    suspend fun delete(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Delete, path, null, headers)",
        "",
        "    /** Sends a request, with a JSON body when there is one. */",
        "    suspend fun send(method: HttpMethod, path: String, body: JsonElement?, headers: Map<String, String>): TestResponse {",
        "        val response = client.request(path) {",
        "            this.method = method",
        "            for ((name, value) in headers) header(name, value)",
        "            if (body != null) {",
        "                contentType(ContentType.Application.Json)",
        "                setBody(body.toString())",
        "            }",
        "        }",
        "        return TestResponse(response.status.value, response.bodyAsText())",
        "    }",
        "}",
        "",
        kt_doc('The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").'),
        "class TestResponse(val status: Int, private val text: String) {",
        "    val json: JsonElement? = if (text.isEmpty()) null else Json.parseToJsonElement(text)",
        "",
        "    fun assertStatus(expected: Int) = assertEquals(expected, status, text)",
        "",
        '    fun at(path: String): JsonElement? = path.split(".").fold(json) { node, part -> (node as? JsonObject)?.get(part) }',
        "}",
        "",
        kt_doc('A copy of a JSON value with another value at a path: listOf("lines", 0, "productId").'),
        "fun JsonElement.with(path: List<Any>, value: JsonElement): JsonElement {",
        "    if (path.isEmpty()) return value",
        "    val rest = path.drop(1)",
        "    return when (val step = path.first()) {",
        "        is String -> JsonObject(jsonObject + (step to (jsonObject[step] ?: JsonObject(emptyMap())).with(rest, value)))",
        "        else -> JsonArray(jsonArray.mapIndexed { index, item -> if (index == step) item.with(rest, value) else item })",
        "    }",
        "}",
        "",
        kt_doc("A copy of a JSON object without a field."),
        "fun JsonObject.without(field: String) = JsonObject(this - field)",
    )
    return {"path": source_path(package, "ApiTest", True), "content": file_text(content)}


def _test_data_file(context: KtorContext) -> dict:
    """Credentials, settings, builders of valid request bodies, and helpers that create items through the API."""
    package = context.base
    common = common_package(context)
    auth = context.settings["auth"]
    database = context.settings.get("database")
    spec = context.spec
    imports = KtImports(package).add(
        "kotlinx.serialization.json.Json",
        "kotlinx.serialization.json.JsonObject",
        "kotlinx.serialization.json.jsonObject",
        f"{common}.Settings",
    )
    if auth == "jwt":
        imports.add("com.auth0.jwt.JWT", "com.auth0.jwt.algorithms.Algorithm", "java.util.Date")
    if context.exposed:
        imports.add(
            "org.jetbrains.exposed.v1.jdbc.Database",
            "org.jetbrains.exposed.v1.jdbc.SchemaUtils",
            "org.jetbrains.exposed.v1.jdbc.transactions.transaction",
            f"{context.base}.database.TABLES",
            "java.util.UUID",
        )
    blocks = []
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
                f"    body = body.with({_path_list(reference['path'])}, "
                f"create{names(target)['type']}().getValue({kt_string(key_wire(target))}))"
            )
        one = article(resource["singular"])
        blocks.append(
            lines(
                f"/** A valid body to create {one}, with the items it refers to created first. */",
                f"suspend fun Api.{name['one']}Payload(variant: Int = 0): JsonObject {{",
                f"    {'var' if fills else 'val'} body = if (variant == 0) {_json(first['body'])} else {_json(second['body'])}",
                fills,
                "    return body.jsonObject",
                "}",
                "",
                f"/** Creates {one} and returns it as the API answers. */",
                f"suspend fun Api.create{name['type']}(variant: Int = 0): JsonObject {{",
                f"    val response = post({kt_string(create['path'])}, {name['one']}Payload(variant), headers())",
                f"    response.assertStatus({number_text(create['status'])})",
                "    return response.json!!.jsonObject",
                "}",
            )
        )
    sqlite = database == "sqlite"
    settings = [
        context.exposed and "    databaseUrl = url,",
        context.exposed and not sqlite and ["    databaseUser = user,", "    databasePassword = password,"],
        auth == "apiKey" and "    apiKeys = listOf(TEST_API_KEY),",
        auth == "jwt" and "    jwtSecret = TEST_JWT_SECRET,",
    ]
    if context.exposed:
        if sqlite:
            fresh = '        "jdbc:sqlite:${System.getProperty("java.io.tmpdir")}/api-test-${UUID.randomUUID()}.db"'
        else:
            fresh = '        "jdbc:h2:mem:test-${UUID.randomUUID()}"'
        credentials = "" if sqlite else ", user = user, password = password"
        test_settings = [
            "fun testSettings(): Settings {",
            "    // TEST_DATABASE_URL runs the tests on that database, emptied first; without it, each test has its own",
            '    val shared = System.getenv("TEST_DATABASE_URL").orEmpty()',
            not sqlite
            and [
                '    val user = System.getenv("TEST_DATABASE_USER").orEmpty()',
                '    val password = System.getenv("TEST_DATABASE_PASSWORD").orEmpty()',
            ],
            "    val url = if (shared.isEmpty()) {",
            fresh,
            "    } else {",
            f"        val database = Database.connect(shared{credentials})",
            "        transaction(database) { SchemaUtils.drop(*TABLES) }",
            "        shared",
            "    }",
            "    return Settings(",
            settings,
            "    )",
            "}",
        ]
    elif auth == "none":
        test_settings = "fun testSettings() = Settings()"
    else:
        test_settings = ["fun testSettings() = Settings(", settings, ")"]
    roles = ", ".join(kt_string(role) for role in spec["roles"])
    content = lines(
        *kt_header(package, imports),
        auth == "apiKey" and [f"const val TEST_API_KEY = {kt_string(TEST_API_KEY)}", ""],
        auth == "jwt" and [f"const val TEST_JWT_SECRET = {kt_string(TEST_JWT_SECRET)}", ""],
        kt_doc("Settings of the application under test."),
        test_settings,
        "",
        kt_doc("Headers of a client allowed to call every endpoint."),
        auth == "none" and "fun headers(): Map<String, String> = emptyMap()",
        auth == "apiKey" and 'fun headers(): Map<String, String> = mapOf("X-API-Key" to TEST_API_KEY)',
        auth == "jwt"
        and [
            'fun headers(): Map<String, String> = mapOf("Authorization" to "Bearer ${token(listOf(' + roles + '))}")',
            "",
            kt_doc("Headers of a client with a valid token but no role."),
            'fun headersWithoutRoles(): Map<String, String> = mapOf("Authorization" to "Bearer ${token(emptyList())}")',
            "",
            kt_doc("A token signed with the test secret, valid for one hour."),
            "fun token(roles: List<String>): String = JWT.create()",
            '    .withSubject("tests")',
            '    .withClaim("roles", roles)',
            "    .withExpiresAt(Date(System.currentTimeMillis() + 3_600_000))",
            "    .sign(Algorithm.HMAC256(TEST_JWT_SECRET))",
        ],
        bool(blocks) and ["", "\n\n".join(blocks)],
    )
    return {"path": source_path(package, "TestData", True), "content": file_text(content)}


def _assert_value(value, actual: str) -> str:
    """A kotlin.test assertion that a value of a JSON answer equals a sample value."""
    if isinstance(value, bool):
        return f"assertEquals({'true' if value else 'false'}, {actual}!!.jsonPrimitive.boolean)"
    if isinstance(value, (int, float)):
        text = number_text(value)
        return f"assertEquals({text + '.0' if float(value).is_integer() else text}, {actual}!!.jsonPrimitive.double)"
    if isinstance(value, str):
        return f"assertEquals({kt_string(value)}, {actual}!!.jsonPrimitive.content)"
    return f"assertEquals({_json(value)}, {actual})"


def _resource_test_file(context: KtorContext, resource: dict) -> dict:
    package = context.base
    spec = context.spec
    name = names(resource)
    type_name = name["type"]
    one = name["one"]
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    used: set[str] = set()

    def test(title: str, body: list, skip: str | None = None) -> None:
        method = _test_name(title)
        n = 2
        while method in used:
            method = f"{_test_name(title)} {n}"
            n += 1
        used.add(method)
        if skip:
            tests.append(
                lines(f"    @Ignore({kt_string(skip)})", "    @Test", f"    fun `{method}`() {{", *body, "    }")
            )
        else:
            tests.append(lines("    @Test", f"    fun `{method}`() = api {{", *body, "    }"))

    created_key = [
        f"        val created = create{type_name}()",
        f"        val key = created.getValue({kt_string(key)}).jsonPrimitive.content",
    ]
    code = 'response.at("error.code")?.jsonPrimitive?.content'

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            test(
                f"{endpoint['name']} answers 501 until the storage is written",
                [
                    f"        val response = get({kt_string(fixed_path(endpoint, resource, missing_key(resource)))}, headers())",
                    "",
                    "        response.assertStatus(501)",
                    f'        assertEquals("not_implemented", {code})',
                ],
            )
    else:
        if create and not can_create:
            todo = problem if problem is not None else "write a body with the items it refers to"
            reason = problem if problem is not None else "An item it refers to cannot be created through the API."
            test(f"creates {article(resource['singular'])}", [f"        // TODO: {todo}"], reason)
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {article(resource['singular'])}",
                [
                    f"        val payload = {one}Payload()",
                    "",
                    f"        val response = post({kt_string(create['path'])}, payload, headers())",
                    "",
                    f"        response.assertStatus({number_text(create['status'])})",
                    "        val body = response.json!!.jsonObject",
                    f"        assertTrue({kt_string(key)} in body)",
                    [
                        f"        assertEquals(payload[{kt_string(wire)}], body[{kt_string(wire)}])"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                wire = kt_string(required["wire"])
                test(
                    f"rejects {article(resource['singular'])} without {required['wire']}",
                    [
                        f"        val payload = {one}Payload().without({wire})",
                        "",
                        f"        val response = post({kt_string(create['path'])}, payload, headers())",
                        "",
                        "        response.assertStatus(400)",
                        f'        assertEquals("validation_error", {code})',
                        '        assertTrue(response.at("error.details")!!.jsonArray.any { '
                        f'it.jsonObject["field"]?.jsonPrimitive?.content == {wire} }})',
                    ],
                )
            if resource["key"]["generated"] is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"        val created = create{type_name}()",
                        f"        val payload = {one}Payload().with(listOf({kt_string(key)}), created.getValue({kt_string(key)}))",
                        "",
                        f"        val response = post({kt_string(create['path'])}, payload, headers())",
                        "",
                        "        response.assertStatus(409)",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {article(resource['singular'])}",
                    [
                        *created_key,
                        "",
                        f"        val response = get({_url(get, resource)}, headers())",
                        "",
                        "        response.assertStatus(200)",
                        "        assertEquals(created, response.json)",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"        val response = get({kt_string(fixed_path(get, resource, missing_key(resource)))}, headers())",
                    "",
                    "        response.assertStatus(404)",
                    f'        assertEquals("not_found", {code})',
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            if listing.get("pagination"):
                checks = [
                    f'        assertEquals({count}, response.at("total")!!.jsonPrimitive.int)',
                    '        assertEquals(1, response.at("page")!!.jsonPrimitive.int)',
                ]
            else:
                checks = f"        assertEquals({count}, response.json!!.jsonArray.size)"
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"        create{type_name}()",
                    can_create and distinct and f"        create{type_name}(1)",
                    "",
                    f"        val response = get({kt_string(listing['path'])}, headers())",
                    "",
                    "        response.assertStatus(200)",
                    checks,
                ],
            )
            if listing.get("pagination") and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"        create{type_name}()",
                        f"        create{type_name}(1)",
                        "",
                        f"        val response = get({kt_string(listing['path'] + '?page=2&size=1')}, headers())",
                        "",
                        "        response.assertStatus(200)",
                        '        assertEquals(2, response.at("total")!!.jsonPrimitive.int)',
                        '        assertEquals(1, response.at("items")!!.jsonArray.size)',
                        '        assertEquals(2, response.at("page")!!.jsonPrimitive.int)',
                    ],
                )
            if listing.get("pagination"):
                test(
                    "rejects a page that does not exist",
                    [
                        f"        val response = get({kt_string(listing['path'] + '?page=0')}, headers())",
                        "",
                        "        response.assertStatus(400)",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            compared = [
                wire
                for wire in comparable_fields(resource, sample_body(spec, resource, 1)["sample"]["body"])
                if wire != key
            ]
            if resource["key"]["generated"] is None:
                payload = f"        val payload = {one}Payload(1).with(listOf({kt_string(key)}), created.getValue({kt_string(key)})).jsonObject"
            else:
                payload = f"        val payload = {one}Payload(1)"
            test(
                f"replaces {article(resource['singular'])}",
                [
                    *created_key,
                    payload,
                    "",
                    f"        val response = put({_url(replace, resource)}, payload, headers())",
                    "",
                    "        response.assertStatus(200)",
                    bool(compared) and "        val body = response.json!!.jsonObject",
                    [f"        assertEquals(payload[{kt_string(wire)}], body[{kt_string(wire)}])" for wire in compared],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            actual = f"response.json!!.jsonObject[{kt_string(field['wire'])}]"
            test(
                f"updates part of {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        val response = patch({_url(update, resource)}, {_json({field['wire']: value})}, headers())",
                    "",
                    "        response.assertStatus(200)",
                    f"        {_assert_value(value, actual)}",
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        *created_key,
                        "",
                        f"        val response = patch({_url(update, resource)}, {_json({field['wire']: None})}, headers())",
                        "",
                        "        response.assertStatus(400)",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        val response = delete({_url(remove, resource)}, headers())",
                    "",
                    f"        response.assertStatus({number_text(remove['status'])})",
                    get and f"        get({_url(get, resource)}, headers()).assertStatus(404)",
                ],
            )
        for endpoint in resource["endpoints"]:
            if endpoint["operation"] != "custom":
                continue
            needs_item = any(param["name"] == resource["key"]["param"] for param in endpoint["pathParams"])
            if (needs_item or endpoint["input"] == "resource") and not can_create:
                continue
            if endpoint["input"] == "none":
                body = "null"
            elif endpoint["input"] == "partial":
                body = "JsonObject(emptyMap())"
            else:
                body = f"{one}Payload()"
            path = _url(endpoint, resource) if needs_item else kt_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{endpoint['name']} answers 501 until it is written",
                [
                    needs_item and created_key,
                    "        // TODO: replace this test when the operation is written",
                    f"        val response = send(HttpMethod({kt_string(endpoint['method'])}), {path}, {body}, headers())",
                    "",
                    "        response.assertStatus(501)",
                ],
            )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{guarded['name']} needs credentials",
            [
                f"        val response = get({kt_string(fixed_path(guarded, resource, missing_key(resource)))})",
                "",
                "        response.assertStatus(401)",
                f'        assertEquals("unauthorized", {code})',
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        test(
            f"{with_roles['name']} needs a role",
            [
                f"        val response = get({kt_string(fixed_path(with_roles, resource, missing_key(resource)))}, headersWithoutRoles())",
                "",
                "        response.assertStatus(403)",
            ],
        )
    body = "\n\n".join(tests)
    imports = KtImports(package).add("kotlin.test.Test", "kotlin.test.assertEquals")
    for text, names_used in (
        ("@Ignore", ["kotlin.test.Ignore"]),
        ("assertTrue", ["kotlin.test.assertTrue"]),
        ("jsonPrimitive", ["kotlinx.serialization.json.jsonPrimitive"]),
        ("jsonObject", ["kotlinx.serialization.json.jsonObject"]),
        ("jsonArray", ["kotlinx.serialization.json.jsonArray"]),
        (".int)", ["kotlinx.serialization.json.int"]),
        (".double)", ["kotlinx.serialization.json.double"]),
        (".boolean)", ["kotlinx.serialization.json.boolean"]),
        ("Json.parseToJsonElement", ["kotlinx.serialization.json.Json"]),
        ("JsonObject(", ["kotlinx.serialization.json.JsonObject"]),
        ("HttpMethod(", ["io.ktor.http.HttpMethod"]),
    ):
        if text in body:
            imports.add(*names_used)
    content = lines(
        *kt_header(package, imports),
        kt_doc(f"Tests of the {resource['plural']} endpoints."),
        f"class {type_name}ApiTest : ApiTest() {{",
        body if tests else ["    @Test", "    fun `has no endpoints`() {", "    }"],
        "}",
    )
    return {"path": source_path(package, f"{type_name}ApiTest", True), "content": file_text(content)}


def test_files(context: KtorContext) -> list[dict]:
    return [
        _api_test_file(context),
        _test_data_file(context),
        *(_resource_test_file(context, resource) for resource in context.spec["resources"]),
    ]
