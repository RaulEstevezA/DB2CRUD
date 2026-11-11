using System.Text.Json.Nodes;
using Xunit;

namespace LibraryApi.Tests;

/// <summary>Tests of the books endpoints.</summary>
public sealed class BookApiTests : ApiTest
{
    [Fact]
    public async Task CreatesABook()
    {
        var payload = await BookPayload();

        var response = await PostJson("/books", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["title"], body["title"]), "title");
        Assert.True(JsonNode.DeepEquals(payload["isbn"], body["isbn"]), "isbn");
        Assert.True(JsonNode.DeepEquals(payload["genre"], body["genre"]), "genre");
        Assert.True(JsonNode.DeepEquals(payload["pages"], body["pages"]), "pages");
        Assert.True(JsonNode.DeepEquals(payload["available"], body["available"]), "available");
    }

    [Fact]
    public async Task RejectsABookWithoutTitle()
    {
        var payload = await BookPayload();
        payload.Remove("title");

        var response = await PostJson("/books", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "title");
    }

    [Fact]
    public async Task GetsABook()
    {
        var created = await CreateBook();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/books/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingBook()
    {
        var response = await GetJson("/books/00000000-0000-0000-0000-000000000000", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsBooks()
    {
        await CreateBook();
        await CreateBook(1);

        var response = await GetJson("/books", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsBooksByPage()
    {
        await CreateBook();
        await CreateBook(1);

        var response = await GetJson("/books?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/books?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesABook()
    {
        var created = await CreateBook();
        var key = created["id"]!.ToString();
        var payload = await BookPayload(1);

        var response = await PutJson($"/books/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["title"], response.Json!["title"]), "title");
        Assert.True(JsonNode.DeepEquals(payload["isbn"], response.Json!["isbn"]), "isbn");
        Assert.True(JsonNode.DeepEquals(payload["genre"], response.Json!["genre"]), "genre");
        Assert.True(JsonNode.DeepEquals(payload["pages"], response.Json!["pages"]), "pages");
        Assert.True(JsonNode.DeepEquals(payload["available"], response.Json!["available"]), "available");
    }

    [Fact]
    public async Task UpdatesPartOfABook()
    {
        var created = await CreateBook();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/books/{key}", JsonNode.Parse("{\"title\":\"title 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("title 2", response.Json!["title"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForTitle()
    {
        var created = await CreateBook();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/books/{key}", JsonNode.Parse("{\"title\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesABook()
    {
        var created = await CreateBook();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/books/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/books/{key}", Headers())).AssertStatus(404);
    }
}
