using System.ComponentModel.DataAnnotations;
using CatalogApi.Common;
using CatalogApi.Dtos;
using CatalogApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace CatalogApi.Controllers;

/// <summary>Routes of items: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class ItemsController(ItemService service) : ControllerBase
{
    /// <summary>List items.</summary>
    [HttpGet("/items")]
    public async Task<IActionResult> ListItems(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListItemsAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<ItemResponse>([.. result.Items.Select(ItemResponse.From)], result.Total, page, size));
    }

    /// <summary>Get an item.</summary>
    [HttpGet("/items/{id}")]
    public async Task<IActionResult> GetItem([FromRoute(Name = "id")] long key)
    {
        return StatusCode(200, ItemResponse.From(await service.GetItemAsync(key)));
    }

    /// <summary>Create an item.</summary>
    [HttpPost("/items")]
    public async Task<IActionResult> CreateItem([FromBody] ItemCreate data)
    {
        return StatusCode(201, ItemResponse.From(await service.CreateItemAsync(data)));
    }

    /// <summary>Replace an item.</summary>
    [HttpPut("/items/{id}")]
    public async Task<IActionResult> ReplaceItem(
        [FromRoute(Name = "id")] long key,
        [FromBody] ItemCreate data)
    {
        return StatusCode(200, ItemResponse.From(await service.ReplaceItemAsync(key, data)));
    }

    /// <summary>Update part of an item.</summary>
    [HttpPatch("/items/{id}")]
    public async Task<IActionResult> UpdateItem(
        [FromRoute(Name = "id")] long key,
        [FromBody] ItemUpdate data)
    {
        return StatusCode(200, ItemResponse.From(await service.UpdateItemAsync(key, data)));
    }

    /// <summary>Delete an item.</summary>
    [HttpDelete("/items/{id}")]
    public async Task<IActionResult> DeleteItem([FromRoute(Name = "id")] long key)
    {
        await service.DeleteItemAsync(key);
        return StatusCode(204);
    }
}
