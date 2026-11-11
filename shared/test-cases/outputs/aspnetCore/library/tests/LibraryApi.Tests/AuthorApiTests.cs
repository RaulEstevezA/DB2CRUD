using System.Text.Json.Nodes;
using Xunit;

namespace LibraryApi.Tests;

/// <summary>Tests of the authors endpoints.</summary>
public sealed class AuthorApiTests : ApiTest
{
    [Fact]
    public async Task CreatesAnAuthor()
    {
        var payload = AuthorPayload();

        var response = await PostJson("/authors", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["name"], body["name"]), "name");
    }

    [Fact]
    public async Task RejectsAnAuthorWithoutName()
    {
        var payload = AuthorPayload();
        payload.Remove("name");

        var response = await PostJson("/authors", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "name");
    }

    [Fact]
    public async Task GetsAnAuthor()
    {
        var created = await CreateAuthor();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/authors/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingAuthor()
    {
        var response = await GetJson("/authors/00000000-0000-0000-0000-000000000000", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsAuthors()
    {
        await CreateAuthor();
        await CreateAuthor(1);

        var response = await GetJson("/authors", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsAuthorsByPage()
    {
        await CreateAuthor();
        await CreateAuthor(1);

        var response = await GetJson("/authors?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/authors?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesAnAuthor()
    {
        var created = await CreateAuthor();
        var key = created["id"]!.ToString();
        var payload = AuthorPayload(1);

        var response = await PutJson($"/authors/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["name"], response.Json!["name"]), "name");
    }

    [Fact]
    public async Task UpdatesPartOfAnAuthor()
    {
        var created = await CreateAuthor();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/authors/{key}", JsonNode.Parse("{\"name\":\"name 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("name 2", response.Json!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForName()
    {
        var created = await CreateAuthor();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/authors/{key}", JsonNode.Parse("{\"name\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesAnAuthor()
    {
        var created = await CreateAuthor();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/authors/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/authors/{key}", Headers())).AssertStatus(404);
    }
}
