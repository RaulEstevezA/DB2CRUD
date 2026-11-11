using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

// The tests run one after another (one collection): each one starts its own application
[assembly: CollectionBehavior(CollectionBehavior.CollectionPerAssembly)]

namespace LibraryApi.Tests;

/// <summary>Base of the tests: a new application for each test, so each one starts with empty storage.</summary>
public abstract partial class ApiTest : IDisposable
{
    private readonly WebApplicationFactory<Program> factory;
    private readonly HttpClient client;

    protected ApiTest()
    {
        factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Testing");
        });
        client = factory.CreateClient();
    }

    public void Dispose()
    {
        client.Dispose();
        factory.Dispose();
        GC.SuppressFinalize(this);
    }

    protected Task<TestResponse> GetJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>
        Send(HttpMethod.Get, path, null, headers);

    protected Task<TestResponse> PostJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>
        Send(HttpMethod.Post, path, body, headers);

    protected Task<TestResponse> PutJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>
        Send(HttpMethod.Put, path, body, headers);

    protected Task<TestResponse> PatchJson(string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers = null) =>
        Send(HttpMethod.Patch, path, body, headers);

    protected Task<TestResponse> DeleteJson(string path, IReadOnlyDictionary<string, string>? headers = null) =>
        Send(HttpMethod.Delete, path, null, headers);

    /// <summary>Sends a request, with a JSON body when there is one.</summary>
    protected async Task<TestResponse> Send(HttpMethod method, string path, JsonNode? body, IReadOnlyDictionary<string, string>? headers)
    {
        using var request = new HttpRequestMessage(method, path);
        if (body is not null)
        {
            request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
        }
        foreach (var (name, value) in headers ?? new Dictionary<string, string>())
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }
        using var response = await client.SendAsync(request);
        return new TestResponse((int)response.StatusCode, await response.Content.ReadAsStringAsync());
    }
}

/// <summary>The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code").</summary>
public sealed class TestResponse(int status, string text)
{
    public int Status { get; } = status;

    public JsonNode? Json { get; } = text.Length > 0 ? JsonNode.Parse(text) : null;

    public void AssertStatus(int expected)
    {
        if (Status != expected)
        {
            Assert.Fail($"Expected {expected}, got {Status}: {text}");
        }
    }

    public JsonNode? At(string path)
    {
        var node = Json;
        foreach (var part in path.Split('.'))
        {
            node = node is JsonObject item ? item[part] : null;
        }
        return node;
    }
}
