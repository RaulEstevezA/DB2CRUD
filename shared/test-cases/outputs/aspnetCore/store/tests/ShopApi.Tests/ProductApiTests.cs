using System.Text.Json.Nodes;
using Xunit;

namespace ShopApi.Tests;

/// <summary>Tests of the products endpoints.</summary>
public sealed class ProductApiTests : ApiTest
{
    [Fact]
    public async Task CreatesAProduct()
    {
        var payload = ProductPayload();

        var response = await PostJson("/products", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["sku"], body["sku"]), "sku");
        Assert.True(JsonNode.DeepEquals(payload["name"], body["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["description"], body["description"]), "description");
        Assert.True(JsonNode.DeepEquals(payload["active"], body["active"]), "active");
    }

    [Fact]
    public async Task RejectsAProductWithoutSku()
    {
        var payload = ProductPayload();
        payload.Remove("sku");

        var response = await PostJson("/products", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "sku");
    }

    [Fact]
    public async Task GetsAProduct()
    {
        var created = await CreateProduct();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/products/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingProduct()
    {
        var response = await GetJson("/products/999999", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsProducts()
    {
        await CreateProduct();
        await CreateProduct(1);

        var response = await GetJson("/products", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsProductsByPage()
    {
        await CreateProduct();
        await CreateProduct(1);

        var response = await GetJson("/products?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/products?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesAProduct()
    {
        var created = await CreateProduct();
        var key = created["id"]!.ToString();
        var payload = ProductPayload(1);

        var response = await PutJson($"/products/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["sku"], response.Json!["sku"]), "sku");
        Assert.True(JsonNode.DeepEquals(payload["name"], response.Json!["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["description"], response.Json!["description"]), "description");
        Assert.True(JsonNode.DeepEquals(payload["active"], response.Json!["active"]), "active");
    }

    [Fact]
    public async Task UpdatesPartOfAProduct()
    {
        var created = await CreateProduct();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/products/{key}", JsonNode.Parse("{\"sku\":\"sku 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("sku 2", response.Json!["sku"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForSku()
    {
        var created = await CreateProduct();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/products/{key}", JsonNode.Parse("{\"sku\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesAProduct()
    {
        var created = await CreateProduct();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/products/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/products/{key}", Headers())).AssertStatus(404);
    }
}
