using System.Text.Json.Nodes;

namespace CatalogApi.Tests;

public abstract partial class ApiTest
{
    /// <summary>Headers of a client allowed to call every endpoint.</summary>
    protected static Dictionary<string, string> Headers() => [];

    /// <summary>A valid body to create a category, with the items it refers to created first.</summary>
    protected static JsonObject CategoryPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"name\":\"name 1\"}")!.AsObject() : JsonNode.Parse("{\"name\":\"name 2\"}")!.AsObject();
        return body;
    }

    /// <summary>Creates a category and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateCategory(int variant = 0)
    {
        var response = await PostJson("/categories", CategoryPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }

    /// <summary>A valid body to create an item, with the items it refers to created first.</summary>
    protected async Task<JsonObject> ItemPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"name\":\"name 1\",\"price\":0,\"supplierEmail\":\"user1@example.com\",\"categoryId\":null,\"stock\":0}")!.AsObject() : JsonNode.Parse("{\"name\":\"name 2\",\"price\":0.5,\"supplierEmail\":\"user2@example.com\",\"categoryId\":null,\"stock\":1}")!.AsObject();
        body["categoryId"] = (await CreateCategory())["id"]!.DeepClone();
        return body;
    }

    /// <summary>Creates an item and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateItem(int variant = 0)
    {
        var response = await PostJson("/items", await ItemPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }
}
