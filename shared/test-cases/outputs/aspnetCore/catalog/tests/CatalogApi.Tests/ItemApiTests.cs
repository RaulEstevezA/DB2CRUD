using System.Text.Json.Nodes;
using Xunit;

namespace CatalogApi.Tests;

/// <summary>Tests of the items endpoints.</summary>
public sealed class ItemApiTests : ApiTest
{
    [Fact]
    public async Task CreatesAnItem()
    {
        var payload = await ItemPayload();

        var response = await PostJson("/items", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["name"], body["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["stock"], body["stock"]), "stock");
    }

    [Fact]
    public async Task RejectsAnItemWithoutName()
    {
        var payload = await ItemPayload();
        payload.Remove("name");

        var response = await PostJson("/items", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "name");
    }

    [Fact]
    public async Task GetsAnItem()
    {
        var created = await CreateItem();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/items/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingItem()
    {
        var response = await GetJson("/items/999999", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsItems()
    {
        await CreateItem();
        await CreateItem(1);

        var response = await GetJson("/items", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsItemsByPage()
    {
        await CreateItem();
        await CreateItem(1);

        var response = await GetJson("/items?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/items?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesAnItem()
    {
        var created = await CreateItem();
        var key = created["id"]!.ToString();
        var payload = await ItemPayload(1);

        var response = await PutJson($"/items/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["name"], response.Json!["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["stock"], response.Json!["stock"]), "stock");
    }

    [Fact]
    public async Task UpdatesPartOfAnItem()
    {
        var created = await CreateItem();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/items/{key}", JsonNode.Parse("{\"name\":\"name 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("name 2", response.Json!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForName()
    {
        var created = await CreateItem();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/items/{key}", JsonNode.Parse("{\"name\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesAnItem()
    {
        var created = await CreateItem();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/items/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/items/{key}", Headers())).AssertStatus(404);
    }
}
