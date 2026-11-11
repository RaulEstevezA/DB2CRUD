/**
 * Tests of the ASP.NET Core project (xUnit on WebApplicationFactory). They call every enabled endpoint the way a
 * client would, with the same cases as every other framework (common/testing.ts). Each test starts the
 * application anew, so it starts with empty storage and can count items exactly.
 */
import type { SpecEndpoint, SpecResource } from '../../../api/spec.ts'
import { sampleBody, updatableField, type JsonValue, type SampleReference } from '../../common/samples.ts'
import {
  TEST_API_KEY,
  TEST_JWT_SECRET,
  comparableFields,
  creatable,
  findEndpoint,
  fixedPath,
  keyWire,
  missingKey,
  pathWithKey,
  protectedEndpoint,
  requiredField,
  roleEndpoint,
  sampleKeysDiffer,
} from '../../common/testing.ts'
import type { GeneratedFile } from '../../common/types.ts'
import { fileText, lines } from '../../common/text.ts'
import { csDoc, csPascal, csString } from '../../languages/csharp/csharp.ts'
import { article, dataNamespace, names, testPath, type AspNetContext } from './context.ts'

/** A C# expression for a path whose key is the variable `key`. */
function url(endpoint: SpecEndpoint, resource: SpecResource): string {
  const [before, after] = pathWithKey(endpoint, resource).split('{key}')
  return after === undefined ? csString(before) : `$${csString(`${before}{key}${after}`)}`
}

/** Where a reference goes in a body: `body["lines"]![0]!["productId"]`. */
function place(path: SampleReference['path']): string {
  return `body${path.map((part, index) => `${index > 0 ? '!' : ''}[${typeof part === 'number' ? part : csString(part)}]`).join('')}`
}

/** A JSON body written in C#: parsed from its text. */
function jsonObject(value: JsonValue): string {
  return `JsonNode.Parse(${csString(JSON.stringify(value))})!.AsObject()`
}

/** A test method name from its title: `creates a customer` → `CreatesACustomer`. */
function methodName(title: string): string {
  return csPascal(title.replace(/[^A-Za-z0-9]+/g, ' '))
}

/** The base of the tests: a new application for each test, and helpers to call it with JSON. */
function apiTestFile(context: AspNetContext): GeneratedFile {
  const { auth, database } = context.settings
  const efCore = context.efCore
  const content = lines(
    'using System.Text;',
    'using System.Text.Json.Nodes;',
    'using Microsoft.AspNetCore.Hosting;',
    'using Microsoft.AspNetCore.Mvc.Testing;',
    efCore && [
      'using Microsoft.EntityFrameworkCore;',
      database !== 'sqlite' && 'using Microsoft.EntityFrameworkCore.Infrastructure;',
      'using Microsoft.Extensions.DependencyInjection;',
      database !== 'sqlite' && 'using Microsoft.Extensions.DependencyInjection.Extensions;',
      `using ${dataNamespace(context)};`,
    ],
    'using Xunit;',
    '',
    '// The tests run one after another (one collection): each one starts its own application',
    '[assembly: CollectionBehavior(CollectionBehavior.CollectionPerAssembly)]',
    '',
    `namespace ${context.root}.Tests;`,
    '',
    csDoc('Base of the tests: a new application for each test, so each one starts with empty storage.'),
    'public abstract partial class ApiTest : IDisposable',
    '{',
    '    private readonly WebApplicationFactory<Program> factory;',
    '    private readonly HttpClient client;',
    '',
    '    protected ApiTest()',
    '    {',
    efCore && [
      '        // TEST_DATABASE_CONNECTION runs the tests on that database; without it, each test has a new SQLite file',
      '        var shared = Environment.GetEnvironmentVariable("TEST_DATABASE_CONNECTION");',
      '        var connection = string.IsNullOrEmpty(shared)',
      '            ? $"Data Source={Path.Combine(Path.GetTempPath(), $"api-test-{Guid.NewGuid():N}.db")}"',
      '            : shared;',
    ],
    '        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>',
    '        {',
    '            builder.UseEnvironment("Testing");',
    auth === 'apiKey' && '            builder.UseSetting("API_KEYS", TestApiKey);',
    auth === 'jwt' && '            builder.UseSetting("JWT_SECRET", TestJwtSecret);',
    efCore && '            builder.UseSetting("DATABASE_CONNECTION", connection);',
    efCore &&
      database !== 'sqlite' && [
        '            if (string.IsNullOrEmpty(shared))',
        '            {',
        '                builder.ConfigureServices(services =>',
        '                {',
        '                    services.RemoveAll<DbContextOptions<AppDbContext>>();',
        '                    services.RemoveAll<IDbContextOptionsConfiguration<AppDbContext>>();',
        '                    services.AddDbContext<AppDbContext>(options => options.UseSqlite(connection));',
        '                });',
        '            }',
      ],
    '        });',
    efCore && [
      '        using (var scope = factory.Services.CreateScope())',
      '        {',
      '            var store = scope.ServiceProvider.GetRequiredService<AppDbContext>().Database;',
      '            // Empty tables for each test',
      '            store.EnsureDeleted();',
      '            store.EnsureCreated();',
      '        }',
    ],
    '        client = factory.CreateClient();',
    '    }',
    '',
    '    public void Dispose()',
    '    {',
    '        client.Dispose();',
    '        factory.Dispose();',
    '        GC.SuppressFinalize(this);',
    '    }',
    '',
    '    protected Task<TestResponse> GetJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>',
    '        Send(HttpMethod.Get, path, null, headers);',
    '',
    '    protected Task<TestResponse> PostJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>',
    '        Send(HttpMethod.Post, path, body, headers);',
    '',
    '    protected Task<TestResponse> PutJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>',
    '        Send(HttpMethod.Put, path, body, headers);',
    '',
    '    protected Task<TestResponse> PatchJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>',
    '        Send(HttpMethod.Patch, path, body, headers);',
    '',
    '    protected Task<TestResponse> DeleteJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>',
    '        Send(HttpMethod.Delete, path, null, headers);',
    '',
    '    /// <summary>Sends a request, with a JSON body when there is one.</summary>',
    '    protected async Task<TestResponse> Send(HttpMethod method, string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers)',
    '    {',
    '        using var request = new HttpRequestMessage(method, path);',
    '        if (body is not null)',
    '        {',
    '            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");',
    '        }',
    '        foreach (var (name, value) in headers ?? new Dictionary<string, string>())',
    '        {',
    '            request.Headers.TryAddWithoutValidation(name, value);',
    '        }',
    '        using var response = await client.SendAsync(request);',
    '        return new TestResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync());',
    '    }',
    '}',
    '',
    csDoc('The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").'),
    'public sealed class TestResponse(int status, string text)',
    '{',
    '    public int Status { get; } = status;',
    '',
    '    public JsonNode? Json { get; } = text.Length > 0 ? JsonNode.Parse(text) : null;',
    '',
    '    public void AssertStatus(int expected)',
    '    {',
    '        if (Status != expected)',
    '        {',
    '            Assert.Fail($"Expected {expected}, got {Status}: {text}");',
    '        }',
    '    }',
    '',
    '    public JsonNode? At(string path)',
    '    {',
    '        var node = Json;',
    "        foreach (var part in path.Split('.'))",
    '        {',
    '            node = node is JsonObject item ? item[part] : null;',
    '        }',
    '        return node;',
    '    }',
    '}',
  )
  return { path: testPath(context, 'ApiTest'), content: fileText(content) }
}

/** Credentials, builders of valid request bodies, and helpers that create items through the API. */
function testDataFile(context: AspNetContext): GeneratedFile {
  const { auth } = context.settings
  const blocks: string[] = []
  for (const resource of context.spec.resources) {
    if (!creatable(context.spec, resource)) continue
    const name = names(resource)
    const create = findEndpoint(resource, 'create')!
    const first = sampleBody(context.spec, resource, 0).sample
    const second = sampleBody(context.spec, resource, 1).sample
    const fills = first.references.map((reference) => {
      const target = context.spec.resources.find((item) => item.name === reference.resource)!
      return `        ${place(reference.path)} = (await Create${names(target).type}())[${csString(keyWire(target))}]!.DeepClone();`
    })
    blocks.push(
      lines(
        `    /// <summary>A valid body to create ${article(resource.singular)}, with the items it refers to created first.</summary>`,
        `    protected ${fills.length > 0 ? 'async Task<JsonObject>' : 'static JsonObject'} ${name.type}Payload(int variant = 0)`,
        '    {',
        `        var body = variant == 0 ? ${jsonObject(first.body as JsonValue)} : ${jsonObject(second.body as JsonValue)};`,
        fills,
        '        return body;',
        '    }',
        '',
        `    /// <summary>Creates ${article(resource.singular)} and returns it as the API answers.</summary>`,
        `    protected async Task<JsonObject> Create${name.type}(int variant = 0)`,
        '    {',
        `        var response = await PostJson(${csString(create.path)}, ${fills.length > 0 ? 'await ' : ''}${name.type}Payload(variant), Headers());`,
        `        response.AssertStatus(${create.status});`,
        '        return response.Json!.AsObject();',
        '    }',
      ),
    )
  }
  const content = lines(
    auth === 'jwt' && 'using System.Text;',
    'using System.Text.Json.Nodes;',
    auth === 'jwt' && ['using Microsoft.IdentityModel.JsonWebTokens;', 'using Microsoft.IdentityModel.Tokens;'],
    '',
    `namespace ${context.root}.Tests;`,
    '',
    'public abstract partial class ApiTest',
    '{',
    auth === 'apiKey' && [`    protected const string TestApiKey = ${csString(TEST_API_KEY)};`, ''],
    auth === 'jwt' && [`    protected const string TestJwtSecret = ${csString(TEST_JWT_SECRET)};`, ''],
    '    /// <summary>Headers of a client allowed to call every endpoint.</summary>',
    auth === 'none' && '    protected static Dictionary<string, string> Headers() => [];',
    auth === 'apiKey' && '    protected static Dictionary<string, string> Headers() => new() { ["X-API-Key"] = TestApiKey };',
    auth === 'jwt' &&
      `    protected static Dictionary<string, string> Headers() => new() { ["Authorization"] = $"Bearer {Token([${context.spec.roles.map(csString).join(', ')}])}" };`,
    auth === 'jwt' && [
      '',
      '    /// <summary>Headers of a client with a valid token but no role.</summary>',
      '    protected static Dictionary<string, string> HeadersWithoutRoles() => new() { ["Authorization"] = $"Bearer {Token([])}" };',
      '',
      '    /// <summary>A token signed with the test secret, valid for one hour.</summary>',
      '    protected static string Token(string[] roles) => new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor',
      '    {',
      '        Claims = new Dictionary<string, object> { ["sub"] = "tests", ["roles"] = roles },',
      '        Expires = DateTime.UtcNow.AddHours(1),',
      '        SigningCredentials = new SigningCredentials(new SymmetricSecurityKey(Encoding.UTF8.GetBytes(TestJwtSecret)), SecurityAlgorithms.HmacSha256),',
      '    });',
    ],
    blocks.length > 0 && ['', blocks.join('\n\n')],
    '}',
  )
  return { path: testPath(context, 'TestData'), content: fileText(content) }
}

/** An xUnit assertion that a value of a JSON answer equals a sample value. */
function assertValue(value: JsonValue, actual: string): string {
  if (typeof value === 'number') return `Assert.Equal(${value}m, ${actual}!.GetValue<decimal>());`
  if (typeof value === 'string') return `Assert.Equal(${csString(value)}, ${actual}!.GetValue<string>());`
  if (typeof value === 'boolean') return `Assert.Equal(${value}, ${actual}!.GetValue<bool>());`
  return `Assert.True(JsonNode.DeepEquals(JsonNode.Parse(${csString(JSON.stringify(value))}), ${actual}));`
}

function resourceTestFile(context: AspNetContext, resource: SpecResource): GeneratedFile {
  const name = names(resource)
  const key = keyWire(resource)
  const tests: string[] = []
  const canCreate = creatable(context.spec, resource)
  const problem = sampleBody(context.spec, resource, 0).problem
  const get = findEndpoint(resource, 'get')
  const create = findEndpoint(resource, 'create')
  const list = findEndpoint(resource, 'list')
  const hasReferences = sampleBody(context.spec, resource, 0).sample.references.length > 0
  const payload = (variant = 0) => `${hasReferences ? 'await ' : ''}${name.type}Payload(${variant === 0 ? '' : variant})`
  const used = new Set<string>()
  const test = (title: string, body: (string | false | null | undefined | string[])[], skip?: string) => {
    let method = methodName(title)
    for (let n = 2; used.has(method); n++) method = `${methodName(title)}${n}`
    used.add(method)
    tests.push(
      lines(
        skip ? `    [Fact(Skip = ${csString(skip)})]` : '    [Fact]',
        `    public ${skip ? 'void' : 'async Task'} ${method}()`,
        '    {',
        ...body,
        '    }',
      ),
    )
  }
  const createdKey = [`        var created = await Create${name.type}();`, `        var key = created[${csString(key)}]!.ToString();`]

  if (context.pending) {
    for (const endpoint of [list, get].filter(Boolean) as SpecEndpoint[]) {
      test(`${endpoint.name} answers 501 until the storage is written`, [
        `        var response = await GetJson(${csString(fixedPath(endpoint, resource, missingKey(resource)))}, Headers());`,
        '',
        '        response.AssertStatus(501);',
        '        Assert.Equal("not_implemented", response.At("error.code")!.GetValue<string>());',
      ])
    }
  } else {
    if (create && !canCreate) {
      test(
        `creates ${article(resource.singular)}`,
        [`        // TODO: ${problem ?? 'write a body with the items it refers to'}`],
        problem ?? 'An item it refers to cannot be created through the API.',
      )
    }
    if (canCreate) {
      const sent = sampleBody(context.spec, resource, 0).sample.body
      test(`creates ${article(resource.singular)}`, [
        `        var payload = ${payload()};`,
        '',
        `        var response = await PostJson(${csString(create!.path)}, payload, Headers());`,
        '',
        `        response.AssertStatus(${create!.status});`,
        '        var body = response.Json!.AsObject();',
        `        Assert.True(body.ContainsKey(${csString(key)}));`,
        comparableFields(resource, sent).map(
          (wire) => `        Assert.True(JsonNode.DeepEquals(payload[${csString(wire)}], body[${csString(wire)}]), ${csString(wire)});`,
        ),
      ])
      const required = requiredField(resource)
      if (required) {
        test(`rejects ${article(resource.singular)} without ${required.wire}`, [
          `        var payload = ${payload()};`,
          `        payload.Remove(${csString(required.wire)});`,
          '',
          `        var response = await PostJson(${csString(create!.path)}, payload, Headers());`,
          '',
          '        response.AssertStatus(400);',
          '        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());',
          `        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == ${csString(required.wire)});`,
        ])
      }
      if (resource.key.generated === null) {
        test(`rejects a second ${resource.singular} with the same key`, [
          `        var created = await Create${name.type}();`,
          `        var payload = ${payload()};`,
          `        payload[${csString(key)}] = created[${csString(key)}]!.DeepClone();`,
          '',
          `        var response = await PostJson(${csString(create!.path)}, payload, Headers());`,
          '',
          '        response.AssertStatus(409);',
        ])
      }
    }
    if (get) {
      if (canCreate) {
        test(`gets ${article(resource.singular)}`, [
          ...createdKey,
          '',
          `        var response = await GetJson(${url(get, resource)}, Headers());`,
          '',
          '        response.AssertStatus(200);',
          '        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());',
        ])
      }
      test(`answers 404 for a missing ${resource.singular}`, [
        `        var response = await GetJson(${csString(fixedPath(get, resource, missingKey(resource)))}, Headers());`,
        '',
        '        response.AssertStatus(404);',
        '        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());',
      ])
    }
    if (list) {
      const distinct = sampleKeysDiffer(context.spec, resource)
      const count = canCreate ? (distinct ? 2 : 1) : 0
      test(`lists ${resource.plural}`, [
        canCreate && `        await Create${name.type}();`,
        canCreate && distinct && `        await Create${name.type}(1);`,
        '',
        `        var response = await GetJson(${csString(list.path)}, Headers());`,
        '',
        '        response.AssertStatus(200);',
        list.pagination
          ? [
              `        Assert.Equal(${count}, response.At("total")!.GetValue<int>());`,
              '        Assert.Equal(1, response.At("page")!.GetValue<int>());',
            ]
          : `        Assert.Equal(${count}, response.Json!.AsArray().Count);`,
      ])
      if (list.pagination && canCreate && distinct) {
        test(`lists ${resource.plural} by page`, [
          `        await Create${name.type}();`,
          `        await Create${name.type}(1);`,
          '',
          `        var response = await GetJson(${csString(`${list.path}?page=2&size=1`)}, Headers());`,
          '',
          '        response.AssertStatus(200);',
          '        Assert.Equal(2, response.At("total")!.GetValue<int>());',
          '        Assert.Single(response.At("items")!.AsArray());',
          '        Assert.Equal(2, response.At("page")!.GetValue<int>());',
        ])
      }
      if (list.pagination) {
        test('rejects a page that does not exist', [
          `        var response = await GetJson(${csString(`${list.path}?page=0`)}, Headers());`,
          '',
          '        response.AssertStatus(400);',
        ])
      }
    }
    const replace = findEndpoint(resource, 'replace')
    if (replace && canCreate) {
      test(`replaces ${article(resource.singular)}`, [
        ...createdKey,
        `        var payload = ${payload(1)};`,
        resource.key.generated === null && `        payload[${csString(key)}] = created[${csString(key)}]!.DeepClone();`,
        '',
        `        var response = await PutJson(${url(replace, resource)}, payload, Headers());`,
        '',
        '        response.AssertStatus(200);',
        comparableFields(resource, sampleBody(context.spec, resource, 1).sample.body)
          .filter((wire) => wire !== key)
          .map(
            (wire) =>
              `        Assert.True(JsonNode.DeepEquals(payload[${csString(wire)}], response.Json![${csString(wire)}]), ${csString(wire)});`,
          ),
      ])
    }
    const update = findEndpoint(resource, 'update')
    const field = updatableField(resource)
    if (update && canCreate && field) {
      const value = sampleBody(context.spec, resource, 1).sample.body[field.wire] ?? null
      test(`updates part of ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `        var response = await PatchJson(${url(update, resource)}, ${jsonObject({ [field.wire]: value })}, Headers());`,
        '',
        '        response.AssertStatus(200);',
        `        ${assertValue(value, `response.Json![${csString(field.wire)}]`)}`,
      ])
      if (!field.nullable) {
        test(`rejects null for ${field.wire}`, [
          ...createdKey,
          '',
          `        var response = await PatchJson(${url(update, resource)}, ${jsonObject({ [field.wire]: null })}, Headers());`,
          '',
          '        response.AssertStatus(400);',
        ])
      }
    }
    const remove = findEndpoint(resource, 'delete')
    if (remove && canCreate) {
      test(`deletes ${article(resource.singular)}`, [
        ...createdKey,
        '',
        `        var response = await DeleteJson(${url(remove, resource)}, Headers());`,
        '',
        `        response.AssertStatus(${remove.status});`,
        get && `        (await GetJson(${url(get, resource)}, Headers())).AssertStatus(404);`,
      ])
    }
    for (const endpoint of resource.endpoints.filter((item) => item.operation === 'custom')) {
      const needsItem = endpoint.pathParams.some((param) => param.name === resource.key.param)
      if ((needsItem || endpoint.input === 'resource') && !canCreate) continue
      const body = endpoint.input === 'none' ? 'null' : endpoint.input === 'partial' ? 'new JsonObject()' : payload()
      const path = needsItem ? url(endpoint, resource) : csString(fixedPath(endpoint, resource, 'sample'))
      test(`${endpoint.name} answers 501 until it is written`, [
        needsItem && createdKey,
        '        // TODO: replace this test when the operation is written',
        `        var response = await Send(new HttpMethod(${csString(endpoint.method)}), ${path}, ${body}, Headers());`,
        '',
        '        response.AssertStatus(501);',
      ])
    }
  }
  const guarded = protectedEndpoint(resource, context.settings.auth)
  if (guarded) {
    test(`${guarded.name} needs credentials`, [
      `        var response = await GetJson(${csString(fixedPath(guarded, resource, missingKey(resource)))});`,
      '',
      '        response.AssertStatus(401);',
      '        Assert.Equal("unauthorized", response.At("error.code")!.GetValue<string>());',
    ])
  }
  const withRoles = roleEndpoint(resource, context.settings.auth)
  if (withRoles) {
    test(`${withRoles.name} needs a role`, [
      `        var response = await GetJson(${csString(fixedPath(withRoles, resource, missingKey(resource)))}, HeadersWithoutRoles());`,
      '',
      '        response.AssertStatus(403);',
    ])
  }
  const className = `${name.type}ApiTests`
  const content = lines(
    'using System.Text.Json.Nodes;',
    'using Xunit;',
    '',
    `namespace ${context.root}.Tests;`,
    '',
    csDoc(`Tests of the ${resource.plural} endpoints.`),
    `public sealed class ${className} : ApiTest`,
    '{',
    tests.length > 0 ? tests.join('\n\n') : ['    [Fact]', '    public void HasNoEndpoints()', '    {', '    }'],
    '}',
  )
  return { path: testPath(context, className), content: fileText(content) }
}

export function testFiles(context: AspNetContext): GeneratedFile[] {
  return [apiTestFile(context), testDataFile(context), ...context.spec.resources.map((resource) => resourceTestFile(context, resource))]
}
