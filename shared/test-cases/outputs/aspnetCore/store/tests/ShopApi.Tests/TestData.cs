using System.Text.Json.Nodes;

namespace ShopApi.Tests;

public abstract partial class ApiTest
{
    /// <summary>Headers of a client allowed to call every endpoint.</summary>
    protected static Dictionary<string, string> Headers() => [];

    /// <summary>A valid body to create a customer, with the items it refers to created first.</summary>
    protected static JsonObject CustomerPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"name\":\"name 1\",\"email\":\"email 1\",\"password\":\"password 1\",\"phone\":\"phone 1\",\"address\":{\"street\":\"street 1\",\"city\":\"city 1\",\"postalCode\":\"postalCode 1\",\"country\":\"country 1\"}}")!.AsObject() : JsonNode.Parse("{\"name\":\"name 2\",\"email\":\"email 2\",\"password\":\"password 2\",\"phone\":\"phone 2\",\"address\":{\"street\":\"street 2\",\"city\":\"city 2\",\"postalCode\":\"postalCode 2\",\"country\":\"country 2\"}}")!.AsObject();
        return body;
    }

    /// <summary>Creates a customer and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateCustomer(int variant = 0)
    {
        var response = await PostJson("/customers", CustomerPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }

    /// <summary>A valid body to create a product, with the items it refers to created first.</summary>
    protected static JsonObject ProductPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"sku\":\"sku 1\",\"name\":\"name 1\",\"description\":\"description 1\",\"price\":1.5,\"stock\":1.5,\"active\":true}")!.AsObject() : JsonNode.Parse("{\"sku\":\"sku 2\",\"name\":\"name 2\",\"description\":\"description 2\",\"price\":2,\"stock\":2,\"active\":false}")!.AsObject();
        return body;
    }

    /// <summary>Creates a product and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateProduct(int variant = 0)
    {
        var response = await PostJson("/products", ProductPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }

    /// <summary>A valid body to create an order, with the items it refers to created first.</summary>
    protected async Task<JsonObject> OrderPayload(int variant = 0)
    {
        var body = variant == 0 ? JsonNode.Parse("{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":1.5,\"unitPrice\":1.5}],\"status\":\"pending\",\"total\":1.5,\"notes\":\"notes 1\"}")!.AsObject() : JsonNode.Parse("{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":2,\"unitPrice\":2}],\"status\":\"paid\",\"total\":2,\"notes\":\"notes 2\"}")!.AsObject();
        body["customerId"] = (await CreateCustomer())["id"]!.DeepClone();
        body["lines"]![0]!["productId"] = (await CreateProduct())["id"]!.DeepClone();
        return body;
    }

    /// <summary>Creates an order and returns it as the API answers.</summary>
    protected async Task<JsonObject> CreateOrder(int variant = 0)
    {
        var response = await PostJson("/orders", await OrderPayload(variant), Headers());
        response.AssertStatus(201);
        return response.Json!.AsObject();
    }
}
