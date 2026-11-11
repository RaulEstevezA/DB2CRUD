"""Tests of the ASP.NET Core project (xUnit on WebApplicationFactory). They call every enabled endpoint the way a
client would, with the same cases as every other framework (common/testing.py). Each test starts the application
anew, so it starts with empty storage and can count items exactly. Mirrors
web/src/core/generators/frameworks/aspnetCore/tests.ts.
"""

import re

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
from ...languages.csharp.csharp import cs_doc, cs_pascal, cs_string
from .context import AspNetContext, article, data_namespace, names, test_path


def _url(endpoint: dict, resource: dict) -> str:
    """A C# expression for a path whose key is the variable key."""
    parts = path_with_key(endpoint, resource).split("{key}")
    if len(parts) == 1:
        return cs_string(parts[0])
    return "$" + cs_string(f"{parts[0]}{{key}}{parts[1]}")


def _place(path: list) -> str:
    """Where a reference goes in a body: body["lines"]![0]!["productId"]."""
    return "body" + "".join(
        f"{'!' if index > 0 else ''}[{part if isinstance(part, int) else cs_string(part)}]"
        for index, part in enumerate(path)
    )


def _json_object(value) -> str:
    """A JSON body written in C#: parsed from its text."""
    return f"JsonNode.Parse({cs_string(json_text(value))})!.AsObject()"


_NOT_WORD = re.compile(r"[^A-Za-z0-9]+")


def _method_name(title: str) -> str:
    """A test method name from its title: creates a customer → CreatesACustomer."""
    return cs_pascal(_NOT_WORD.sub(" ", title))


def _api_test_file(context: AspNetContext) -> dict:
    """The base of the tests: a new application for each test, and helpers to call it with JSON."""
    auth = context.settings["auth"]
    database = context.settings.get("database")
    ef_core = context.ef_core
    content = lines(
        "using System.Text;",
        "using System.Text.Json.Nodes;",
        "using Microsoft.AspNetCore.Hosting;",
        "using Microsoft.AspNetCore.Mvc.Testing;",
        ef_core
        and [
            "using Microsoft.EntityFrameworkCore;",
            database != "sqlite" and "using Microsoft.EntityFrameworkCore.Infrastructure;",
            "using Microsoft.Extensions.DependencyInjection;",
            database != "sqlite" and "using Microsoft.Extensions.DependencyInjection.Extensions;",
            f"using {data_namespace(context)};",
        ],
        "using Xunit;",
        "",
        "// The tests run one after another (one collection): each one starts its own application",
        "[assembly: CollectionBehavior(CollectionBehavior.CollectionPerAssembly)]",
        "",
        f"namespace {context.root}.Tests;",
        "",
        cs_doc("Base of the tests: a new application for each test, so each one starts with empty storage."),
        "public abstract partial class ApiTest : IDisposable",
        "{",
        "    private readonly WebApplicationFactory<Program> factory;",
        "    private readonly HttpClient client;",
        "",
        "    protected ApiTest()",
        "    {",
        ef_core
        and [
            "        // TEST_DATABASE_CONNECTION runs the tests on that database; without it, each test has a new SQLite file",
            '        var shared = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
            "        var connection = string.IsNullOrEmpty(shared)",
            '            ? $"Data Source={Path.Combine(Path.GetTempPath(), $"api-test-{Guid.NewGuid():N}.db")}"',
            "            : shared;",
        ],
        "        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>",
        "        {",
        '            builder.UseEnvironment("Testing");',
        auth == "apiKey" and '            builder.UseSetting("API_KEYS", TestApiKey);',
        auth == "jwt" and '            builder.UseSetting("JWT_SECRET", TestJwtSecret);',
        ef_core and '            builder.UseSetting("DATABASE_CONNECTION", connection);',
        ef_core
        and database != "sqlite"
        and [
            "            if (string.IsNullOrEmpty(shared))",
            "            {",
            "                builder.ConfigureServices(services =>",
            "                {",
            "                    services.RemoveAll<DbContextOptions<AppDbContext>>();",
            "                    services.RemoveAll<IDbContextOptionsConfiguration<AppDbContext>>();",
            "                    services.AddDbContext<AppDbContext>(options => options.UseSqlite(connection));",
            "                });",
            "            }",
        ],
        "        });",
        ef_core
        and [
            "        using (var scope = factory.Services.CreateScope())",
            "        {",
            "            var store = scope.ServiceProvider.GetRequiredService<AppDbContext>().Database;",
            "            // Empty tables for each test",
            "            store.EnsureDeleted();",
            "            store.EnsureCreated();",
            "        }",
        ],
        "        client = factory.CreateClient();",
        "    }",
        "",
        "    public void Dispose()",
        "    {",
        "        client.Dispose();",
        "        factory.Dispose();",
        "        GC.SuppressFinalize(this);",
        "    }",
        "",
        "    protected Task<TestResponse> GetJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>",
        "        Send(HttpMethod.Get, path, null, headers);",
        "",
        "    protected Task<TestResponse> PostJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>",
        "        Send(HttpMethod.Post, path, body, headers);",
        "",
        "    protected Task<TestResponse> PutJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>",
        "        Send(HttpMethod.Put, path, body, headers);",
        "",
        "    protected Task<TestResponse> PatchJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>",
        "        Send(HttpMethod.Patch, path, body, headers);",
        "",
        "    protected Task<TestResponse> DeleteJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>",
        "        Send(HttpMethod.Delete, path, null, headers);",
        "",
        "    /// <summary>Sends a request, with a JSON body when there is one.</summary>",
        "    protected async Task<TestResponse> Send(HttpMethod method, string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers)",
        "    {",
        "        using var request = new HttpRequestMessage(method, path);",
        "        if (body is not null)",
        "        {",
        '            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");',
        "        }",
        "        foreach (var (name, value) in headers ?? new Dictionary<string, string>())",
        "        {",
        "            request.Headers.TryAddWithoutValidation(name, value);",
        "        }",
        "        using var response = await client.SendAsync(request);",
        "        return new TestResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync());",
        "    }",
        "}",
        "",
        cs_doc('The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").'),
        "public sealed class TestResponse(int status, string text)",
        "{",
        "    public int Status { get; } = status;",
        "",
        "    public JsonNode? Json { get; } = text.Length > 0 ? JsonNode.Parse(text) : null;",
        "",
        "    public void AssertStatus(int expected)",
        "    {",
        "        if (Status != expected)",
        "        {",
        '            Assert.Fail($"Expected {expected}, got {Status}: {text}");',
        "        }",
        "    }",
        "",
        "    public JsonNode? At(string path)",
        "    {",
        "        var node = Json;",
        "        foreach (var part in path.Split('.'))",
        "        {",
        "            node = node is JsonObject item ? item[part] : null;",
        "        }",
        "        return node;",
        "    }",
        "}",
    )
    return {"path": test_path(context, "ApiTest"), "content": file_text(content)}


def _test_data_file(context: AspNetContext) -> dict:
    """Credentials, builders of valid request bodies, and helpers that create items through the API."""
    auth = context.settings["auth"]
    spec = context.spec
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
                f"        {_place(reference['path'])} = "
                f"(await Create{names(target)['type']}())[{cs_string(key_wire(target))}]!.DeepClone();"
            )
        kind = "async Task<JsonObject>" if fills else "static JsonObject"
        awaits = "await " if fills else ""
        one = article(resource["singular"])
        blocks.append(
            lines(
                f"    /// <summary>A valid body to create {one}, with the items it refers to created first.</summary>",
                f"    protected {kind} {name['type']}Payload(int variant = 0)",
                "    {",
                f"        var body = variant == 0 ? {_json_object(first['body'])} : {_json_object(second['body'])};",
                fills,
                "        return body;",
                "    }",
                "",
                f"    /// <summary>Creates {one} and returns it as the API answers.</summary>",
                f"    protected async Task<JsonObject> Create{name['type']}(int variant = 0)",
                "    {",
                f"        var response = await PostJson({cs_string(create['path'])}, {awaits}{name['type']}Payload(variant), Headers());",
                f"        response.AssertStatus({create['status']});",
                "        return response.Json!.AsObject();",
                "    }",
            )
        )
    roles = ", ".join(cs_string(role) for role in spec["roles"])
    content = lines(
        auth == "jwt" and "using System.Text;",
        "using System.Text.Json.Nodes;",
        auth == "jwt" and ["using Microsoft.IdentityModel.JsonWebTokens;", "using Microsoft.IdentityModel.Tokens;"],
        "",
        f"namespace {context.root}.Tests;",
        "",
        "public abstract partial class ApiTest",
        "{",
        auth == "apiKey" and [f"    protected const string TestApiKey = {cs_string(TEST_API_KEY)};", ""],
        auth == "jwt" and [f"    protected const string TestJwtSecret = {cs_string(TEST_JWT_SECRET)};", ""],
        "    /// <summary>Headers of a client allowed to call every endpoint.</summary>",
        auth == "none" and "    protected static Dictionary<string, string> Headers() => [];",
        auth == "apiKey"
        and '    protected static Dictionary<string, string> Headers() => new() { ["X-API-Key"] = TestApiKey };',
        auth == "jwt"
        and "    protected static Dictionary<string, string> Headers() => "
        f'new() {{ ["Authorization"] = $"Bearer {{Token([{roles}])}}" }};',
        auth == "jwt"
        and [
            "",
            "    /// <summary>Headers of a client with a valid token but no role.</summary>",
            '    protected static Dictionary<string, string> HeadersWithoutRoles() => new() { ["Authorization"] = $"Bearer {Token([])}" };',
            "",
            "    /// <summary>A token signed with the test secret, valid for one hour.</summary>",
            "    protected static string Token(string[] roles) => new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor",
            "    {",
            '        Claims = new Dictionary<string, object> { ["sub"] = "tests", ["roles"] = roles },',
            "        Expires = DateTime.UtcNow.AddHours(1),",
            "        SigningCredentials = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(TestJwtSecret)), SecurityAlgorithms.HmacSha256),",
            "    });",
        ],
        bool(blocks) and ["", "\n\n".join(blocks)],
        "}",
    )
    return {"path": test_path(context, "TestData"), "content": file_text(content)}


def _assert_value(value, actual: str) -> str:
    """An xUnit assertion that a value of a JSON answer equals a sample value."""
    if isinstance(value, bool):
        return f"Assert.Equal({'true' if value else 'false'}, {actual}!.GetValue<bool>());"
    if isinstance(value, (int, float)):
        return f"Assert.Equal({json_text(value)}m, {actual}!.GetValue<decimal>());"
    if isinstance(value, str):
        return f"Assert.Equal({cs_string(value)}, {actual}!.GetValue<string>());"
    return f"Assert.True(JsonNode.DeepEquals(JsonNode.Parse({cs_string(json_text(value))}), {actual}));"


def _resource_test_file(context: AspNetContext, resource: dict) -> dict:
    spec = context.spec
    name = names(resource)
    type_name = name["type"]
    key = key_wire(resource)
    tests: list[str] = []
    can_create = creatable(spec, resource)
    problem = sample_body(spec, resource, 0)["problem"]
    get = find_endpoint(resource, "get")
    create = find_endpoint(resource, "create")
    listing = find_endpoint(resource, "list")
    has_references = bool(sample_body(spec, resource, 0)["sample"]["references"])

    def payload(variant: int = 0) -> str:
        return f"{'await ' if has_references else ''}{type_name}Payload({'' if variant == 0 else variant})"

    used: set[str] = set()

    def test(title: str, body: list, skip: str | None = None) -> None:
        method = _method_name(title)
        n = 2
        while method in used:
            method = f"{_method_name(title)}{n}"
            n += 1
        used.add(method)
        tests.append(
            lines(
                f"    [Fact(Skip = {cs_string(skip)})]" if skip else "    [Fact]",
                f"    public {'void' if skip else 'async Task'} {method}()",
                "    {",
                *body,
                "    }",
            )
        )

    created_key = [
        f"        var created = await Create{type_name}();",
        f"        var key = created[{cs_string(key)}]!.ToString();",
    ]
    error_code = 'response.At("error.code")!.GetValue<string>()'

    if context.pending:
        for endpoint in [item for item in (listing, get) if item]:
            test(
                f"{endpoint['name']} answers 501 until the storage is written",
                [
                    f"        var response = await GetJson({cs_string(fixed_path(endpoint, resource, missing_key(resource)))}, Headers());",
                    "",
                    "        response.AssertStatus(501);",
                    f'        Assert.Equal("not_implemented", {error_code});',
                ],
            )
    else:
        reason = problem if problem is not None else "An item it refers to cannot be created through the API."
        if create and not can_create:
            todo = problem if problem is not None else "write a body with the items it refers to"
            test(f"creates {article(resource['singular'])}", [f"        // TODO: {todo}"], reason)
        if can_create:
            sent = sample_body(spec, resource, 0)["sample"]["body"]
            test(
                f"creates {article(resource['singular'])}",
                [
                    f"        var payload = {payload()};",
                    "",
                    f"        var response = await PostJson({cs_string(create['path'])}, payload, Headers());",
                    "",
                    f"        response.AssertStatus({create['status']});",
                    "        var body = response.Json!.AsObject();",
                    f"        Assert.True(body.ContainsKey({cs_string(key)}));",
                    [
                        f"        Assert.True(JsonNode.DeepEquals(payload[{cs_string(wire)}], body[{cs_string(wire)}]), {cs_string(wire)});"
                        for wire in comparable_fields(resource, sent)
                    ],
                ],
            )
            required = required_field(resource)
            if required:
                test(
                    f"rejects {article(resource['singular'])} without {required['wire']}",
                    [
                        f"        var payload = {payload()};",
                        f"        payload.Remove({cs_string(required['wire'])});",
                        "",
                        f"        var response = await PostJson({cs_string(create['path'])}, payload, Headers());",
                        "",
                        "        response.AssertStatus(400);",
                        f'        Assert.Equal("validation_error", {error_code});',
                        '        Assert.Contains(response.At("error.details")!.AsArray(), detail => '
                        f'detail!["field"]!.GetValue<string>() == {cs_string(required["wire"])});',
                    ],
                )
            if resource["key"]["generated"] is None:
                test(
                    f"rejects a second {resource['singular']} with the same key",
                    [
                        f"        var created = await Create{type_name}();",
                        f"        var payload = {payload()};",
                        f"        payload[{cs_string(key)}] = created[{cs_string(key)}]!.DeepClone();",
                        "",
                        f"        var response = await PostJson({cs_string(create['path'])}, payload, Headers());",
                        "",
                        "        response.AssertStatus(409);",
                    ],
                )
        if get:
            if can_create:
                test(
                    f"gets {article(resource['singular'])}",
                    [
                        *created_key,
                        "",
                        f"        var response = await GetJson({_url(get, resource)}, Headers());",
                        "",
                        "        response.AssertStatus(200);",
                        "        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());",
                    ],
                )
            test(
                f"answers 404 for a missing {resource['singular']}",
                [
                    f"        var response = await GetJson({cs_string(fixed_path(get, resource, missing_key(resource)))}, Headers());",
                    "",
                    "        response.AssertStatus(404);",
                    f'        Assert.Equal("not_found", {error_code});',
                ],
            )
        if listing:
            distinct = sample_keys_differ(spec, resource)
            count = (2 if distinct else 1) if can_create else 0
            if listing.get("pagination"):
                checks = [
                    f'        Assert.Equal({count}, response.At("total")!.GetValue<int>());',
                    '        Assert.Equal(1, response.At("page")!.GetValue<int>());',
                ]
            else:
                checks = f"        Assert.Equal({count}, response.Json!.AsArray().Count);"
            test(
                f"lists {resource['plural']}",
                [
                    can_create and f"        await Create{type_name}();",
                    can_create and distinct and f"        await Create{type_name}(1);",
                    "",
                    f"        var response = await GetJson({cs_string(listing['path'])}, Headers());",
                    "",
                    "        response.AssertStatus(200);",
                    checks,
                ],
            )
            if listing.get("pagination") and can_create and distinct:
                test(
                    f"lists {resource['plural']} by page",
                    [
                        f"        await Create{type_name}();",
                        f"        await Create{type_name}(1);",
                        "",
                        f"        var response = await GetJson({cs_string(listing['path'] + '?page=2&size=1')}, Headers());",
                        "",
                        "        response.AssertStatus(200);",
                        '        Assert.Equal(2, response.At("total")!.GetValue<int>());',
                        '        Assert.Single(response.At("items")!.AsArray());',
                        '        Assert.Equal(2, response.At("page")!.GetValue<int>());',
                    ],
                )
            if listing.get("pagination"):
                test(
                    "rejects a page that does not exist",
                    [
                        f"        var response = await GetJson({cs_string(listing['path'] + '?page=0')}, Headers());",
                        "",
                        "        response.AssertStatus(400);",
                    ],
                )
        replace = find_endpoint(resource, "replace")
        if replace and can_create:
            replaced = sample_body(spec, resource, 1)["sample"]["body"]
            test(
                f"replaces {article(resource['singular'])}",
                [
                    *created_key,
                    f"        var payload = {payload(1)};",
                    resource["key"]["generated"] is None
                    and f"        payload[{cs_string(key)}] = created[{cs_string(key)}]!.DeepClone();",
                    "",
                    f"        var response = await PutJson({_url(replace, resource)}, payload, Headers());",
                    "",
                    "        response.AssertStatus(200);",
                    [
                        f"        Assert.True(JsonNode.DeepEquals(payload[{cs_string(wire)}], response.Json![{cs_string(wire)}]), {cs_string(wire)});"
                        for wire in comparable_fields(resource, replaced)
                        if wire != key
                    ],
                ],
            )
        update = find_endpoint(resource, "update")
        field = updatable_field(resource)
        if update and can_create and field:
            value = sample_body(spec, resource, 1)["sample"]["body"].get(field["wire"])
            test(
                f"updates part of {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        var response = await PatchJson({_url(update, resource)}, {_json_object({field['wire']: value})}, Headers());",
                    "",
                    "        response.AssertStatus(200);",
                    "        " + _assert_value(value, "response.Json![" + cs_string(field["wire"]) + "]"),
                ],
            )
            if not field["nullable"]:
                test(
                    f"rejects null for {field['wire']}",
                    [
                        *created_key,
                        "",
                        f"        var response = await PatchJson({_url(update, resource)}, {_json_object({field['wire']: None})}, Headers());",
                        "",
                        "        response.AssertStatus(400);",
                    ],
                )
        remove = find_endpoint(resource, "delete")
        if remove and can_create:
            test(
                f"deletes {article(resource['singular'])}",
                [
                    *created_key,
                    "",
                    f"        var response = await DeleteJson({_url(remove, resource)}, Headers());",
                    "",
                    f"        response.AssertStatus({remove['status']});",
                    get and f"        (await GetJson({_url(get, resource)}, Headers())).AssertStatus(404);",
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
                body = "new JsonObject()"
            else:
                body = payload()
            path = _url(endpoint, resource) if needs_item else cs_string(fixed_path(endpoint, resource, "sample"))
            test(
                f"{endpoint['name']} answers 501 until it is written",
                [
                    needs_item and created_key,
                    "        // TODO: replace this test when the operation is written",
                    f"        var response = await Send(new HttpMethod({cs_string(endpoint['method'])}), {path}, {body}, Headers());",
                    "",
                    "        response.AssertStatus(501);",
                ],
            )
    guarded = protected_endpoint(resource, context.settings["auth"])
    if guarded:
        test(
            f"{guarded['name']} needs credentials",
            [
                f"        var response = await GetJson({cs_string(fixed_path(guarded, resource, missing_key(resource)))});",
                "",
                "        response.AssertStatus(401);",
                f'        Assert.Equal("unauthorized", {error_code});',
            ],
        )
    with_roles = role_endpoint(resource, context.settings["auth"])
    if with_roles:
        test(
            f"{with_roles['name']} needs a role",
            [
                f"        var response = await GetJson({cs_string(fixed_path(with_roles, resource, missing_key(resource)))}, HeadersWithoutRoles());",
                "",
                "        response.AssertStatus(403);",
            ],
        )
    class_name = f"{type_name}ApiTests"
    content = lines(
        "using System.Text.Json.Nodes;",
        "using Xunit;",
        "",
        f"namespace {context.root}.Tests;",
        "",
        cs_doc(f"Tests of the {resource['plural']} endpoints."),
        f"public sealed class {class_name} : ApiTest",
        "{",
        "\n\n".join(tests) if tests else ["    [Fact]", "    public void HasNoEndpoints()", "    {", "    }"],
        "}",
    )
    return {"path": test_path(context, class_name), "content": file_text(content)}


def test_files(context: AspNetContext) -> list[dict]:
    return [
        _api_test_file(context),
        _test_data_file(context),
        *(_resource_test_file(context, resource) for resource in context.spec["resources"]),
    ]
