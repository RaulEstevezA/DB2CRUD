using System.Text.Json.Nodes;

namespace LibraryApi.Tests;

public abstract partial class ApiTest
{
    /// <summary>Headers of a client allowed to call every endpoint.</summary>
    protected static Dictionary<string, string> Headers() => [];

    /// <summary>A valid body to create an author, with the items it refers to created first.</summary>
    protected static JsonObject AuthorPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"name\":\"name 1\",\"email\":\"user1@example.com\",\"born\":\"2024-01-15\"}")!.AsObject() : JsonNode.Parse("{\"name\":\"name 2\",\"email\":\"user2@example.com\",\"born\":\"2024-01-16\"}")!.AsObject();
        return body;
    }

    /// <summary>Creates an author and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateAuthor(int variant = 0)
    {
        var response = await PostJson("/authors", AuthorPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }

    /// <summary>A valid body to create a book, with the items it refers to created first.</summary>
    protected async Task<JsonObject> BookPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"title\":\"title 1\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"novel\",\"pages\":1,\"published\":\"2024-01-15\",\"available\":true}")!.AsObject() : JsonNode.Parse("{\"title\":\"title 2\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"essay\",\"pages\":2,\"published\":\"2024-01-16\",\"available\":false}")!.AsObject();
        body["authorId"] = (await CreateAuthor())["id"]!.DeepClone();
        return body;
    }

    /// <summary>Creates a book and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateBook(int variant = 0)
    {
        var response = await PostJson("/books", await BookPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }
}
