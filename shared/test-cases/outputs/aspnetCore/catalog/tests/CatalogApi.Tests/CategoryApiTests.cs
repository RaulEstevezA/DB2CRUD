using System.Text.Json.Nodes;
using Xunit;

namespace CatalogApi.Tests;

/// <summary>Tests of the categories endpoints.</summary>
public sealed class CategoryApiTests : ApiTest
{
    [Fact]
    public async Task CreatesACategory()
    {
        var payload = CategoryPayload();

        var response = await PostJson("/categories", payload, Headers());

        response.AssertStatus(201);
        var body = response.Json!.AsObject();
        Assert.True(body.ContainsKey("id"));
        Assert.True(JsonNode.DeepEquals(payload["name"], body["name"]), "name");
    }

    [Fact]
    public async Task RejectsACategoryWithoutName()
    {
        var payload = CategoryPayload();
        payload.Remove("name");

        var response = await PostJson("/categories", payload, Headers());

        response.AssertStatus(400);
        Assert.Equal("validation_error", response.At("error.code")!.GetValue<string>());
        Assert.Contains(response.At("error.details")!.AsArray(), detail => detail!["field"]!.GetValue<string>() == "name");
    }

    [Fact]
    public async Task GetsACategory()
    {
        var created = await CreateCategory();
        var key = created["id"]!.ToString();

        var response = await GetJson($"/categories/{key}", Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(created, response.Json), response.Json?.ToJsonString());
    }

    [Fact]
    public async Task Answers404ForAMissingCategory()
    {
        var response = await GetJson("/categories/999999", Headers());

        response.AssertStatus(404);
        Assert.Equal("not_found", response.At("error.code")!.GetValue<string>());
    }

    [Fact]
    public async Task ListsCategories()
    {
        await CreateCategory();
        await CreateCategory(1);

        var response = await GetJson("/categories", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Equal(1, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task ListsCategoriesByPage()
    {
        await CreateCategory();
        await CreateCategory(1);

        var response = await GetJson("/categories?page=2&size=1", Headers());

        response.AssertStatus(200);
        Assert.Equal(2, response.At("total")!.GetValue<int>());
        Assert.Single(response.At("items")!.AsArray());
        Assert.Equal(2, response.At("page")!.GetValue<int>());
    }

    [Fact]
    public async Task RejectsAPageThatDoesNotExist()
    {
        var response = await GetJson("/categories?page=0", Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task ReplacesACategory()
    {
        var created = await CreateCategory();
        var key = created["id"]!.ToString();
        var payload = CategoryPayload(1);

        var response = await PutJson($"/categories/{key}", payload, Headers());

        response.AssertStatus(200);
        Assert.True(JsonNode.DeepEquals(payload["name"], response.Json!["name"]), "name");
    }

    [Fact]
    public async Task UpdatesPartOfACategory()
    {
        var created = await CreateCategory();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/categories/{key}", JsonNode.Parse("{\"name\":\"name 2\"}")!.AsObject(), Headers());

        response.AssertStatus(200);
        Assert.Equal("name 2", response.Json!["name"]!.GetValue<string>());
    }

    [Fact]
    public async Task RejectsNullForName()
    {
        var created = await CreateCategory();
        var key = created["id"]!.ToString();

        var response = await PatchJson($"/categories/{key}", JsonNode.Parse("{\"name\":null}")!.AsObject(), Headers());

        response.AssertStatus(400);
    }

    [Fact]
    public async Task DeletesACategory()
    {
        var created = await CreateCategory();
        var key = created["id"]!.ToString();

        var response = await DeleteJson($"/categories/{key}", Headers());

        response.AssertStatus(204);
        (await GetJson($"/categories/{key}", Headers())).AssertStatus(404);
    }
}
