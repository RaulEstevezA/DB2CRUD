using System.Text.Json.Nodes;
using Xunit;

namespace ShopApi.Tests;

/// <summary>Tests of the customers endpoints.</summary>
public sealed class CustomerApiTests : ApiTest
{
    [Fact]
    public async Task CreatesACustomer()
    {
        var payload = CustomerPayload();

        var response = await PostJson("/customers", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["name"], body["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["email"], body["email"]), "email");
        Assert.True(JsonNode.DeepEquals(payload["phone"], body["phone"]), "phone");
    }

    [Fact]
    public async Task RejectsACustomerWithoutName()
    {
        var payload = CustomerPayload();
        payload.Remove("name");

        var response = await PostJson("/customers", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "name");
    }

    [Fact]
    public async Task GetsACustomer()
    {
        var created = await CreateCustomer();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/customers/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingCustomer()
    {
        var response = await GetJson("/customers/999999", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsCustomers()
    {
        await CreateCustomer();
        await CreateCustomer(1);

        var response = await GetJson("/customers", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsCustomersByPage()
    {
        await CreateCustomer();
        await CreateCustomer(1);

        var response = await GetJson("/customers?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/customers?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesACustomer()
    {
        var created = await CreateCustomer();
        var key = created["id"]!.ToString();
        var payload = CustomerPayload(1);

        var response = await PutJson($"/customers/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["name"], response.Json!["name"]), "name");
        Assert.True(JsonNode.DeepEquals(payload["email"], response.Json!["email"]), "email");
        Assert.True(JsonNode.DeepEquals(payload["phone"], response.Json!["phone"]), "phone");
    }

    [Fact]
    public async Task UpdatesPartOfACustomer()
    {
        var created = await CreateCustomer();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/customers/{key}", JsonNode.Parse("{\"name\":\"name 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("name 2", response.Json!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForName()
    {
        var created = await CreateCustomer();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/customers/{key}", JsonNode.Parse("{\"name\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesACustomer()
    {
        var created = await CreateCustomer();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/customers/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/customers/{key}", Headers())).AssertStatus(404);
    }
}
