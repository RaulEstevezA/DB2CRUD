using System.Text.Json.Nodes;
using Xunit;

namespace ShopApi.Tests;

/// <summary>Tests of the orders endpoints.</summary>
public sealed class OrderApiTests : ApiTest
{
    [Fact]
    public async Task CreatesAnOrder()
    {
        var payload = await OrderPayload();

        var response = await PostJson("/orders", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["status"], body["status"]), "status");
        Assert.True(JsonNode.DeepEquals(payload["notes"], body["notes"]), "notes");
    }

    [Fact]
    public async Task RejectsAnOrderWithoutLines()
    {
        var payload = await OrderPayload();
        payload.Remove("lines");

        var response = await PostJson("/orders", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "lines");
    }

    [Fact]
    public async Task GetsAnOrder()
    {
        var created = await CreateOrder();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/orders/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingOrder()
    {
        var response = await GetJson("/orders/999999", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsOrders()
    {
        await CreateOrder();
        await CreateOrder(1);

        var response = await GetJson("/orders", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsOrdersByPage()
    {
        await CreateOrder();
        await CreateOrder(1);

        var response = await GetJson("/orders?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/orders?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesAnOrder()
    {
        var created = await CreateOrder();
        var key = created["id"]!.ToString();
        var payload = await OrderPayload(1);

        var response = await PutJson($"/orders/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["status"], response.Json!["status"]), "status");
        Assert.True(JsonNode.DeepEquals(payload["notes"], response.Json!["notes"]), "notes");
    }

    [Fact]
    public async Task UpdatesPartOfAnOrder()
    {
        var created = await CreateOrder();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/orders/{key}", JsonNode.Parse("{\"total\":2}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal(2m, response.Json!["total"]!.GetValue<decimal>());
    }

    [Fact]
    public async Task RejectsNullForTotal()
    {
        var created = await CreateOrder();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/orders/{key}", JsonNode.Parse("{\"total\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesAnOrder()
    {
        var created = await CreateOrder();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/orders/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/orders/{key}", Headers())).AssertStatus(404);
    }
}
