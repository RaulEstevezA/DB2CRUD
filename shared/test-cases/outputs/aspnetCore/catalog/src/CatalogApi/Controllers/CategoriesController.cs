using System.ComponentModel.DataAnnotations;
using CatalogApi.Common;
using CatalogApi.Dtos;
using CatalogApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace CatalogApi.Controllers;

/// <summary>Routes of categories: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class CategoriesController(CategoryService service) : ControllerBase
{
    /// <summary>List categories.</summary>
    [HttpGet("/categories")]
    public async Task<IActionResult> ListCategories(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListCategoriesAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<CategoryResponse>([.. result.Items.Select(CategoryResponse.From)], result.Total, page, size));
    }

    /// <summary>Get a category.</summary>
    [HttpGet("/categories/{id}")]
    public async Task<IActionResult> GetCategory([FromRoute(Name = "id")] long key)
    {
        return StatusCode(200, CategoryResponse.From(await service.GetCategoryAsync(key)));
    }

    /// <summary>Create a category.</summary>
    [HttpPost("/categories")]
    public async Task<IActionResult> CreateCategory([FromBody] CategoryCreate data)
    {
        return StatusCode(201, CategoryResponse.From(await service.CreateCategoryAsync(data)));
    }

    /// <summary>Replace a category.</summary>
    [HttpPut("/categories/{id}")]
    public async Task<IActionResult> ReplaceCategory(
        [FromRoute(Name = "id")] long key,
        [FromBody] CategoryCreate data)
    {
        return StatusCode(200, CategoryResponse.From(await service.ReplaceCategoryAsync(key, data)));
    }

    /// <summary>Update part of a category.</summary>
    [HttpPatch("/categories/{id}")]
    public async Task<IActionResult> UpdateCategory(
        [FromRoute(Name = "id")] long key,
        [FromBody] CategoryUpdate data)
    {
        return StatusCode(200, CategoryResponse.From(await service.UpdateCategoryAsync(key, data)));
    }

    /// <summary>Delete a category.</summary>
    [HttpDelete("/categories/{id}")]
    public async Task<IActionResult> DeleteCategory([FromRoute(Name = "id")] long key)
    {
        await service.DeleteCategoryAsync(key);
        return StatusCode(204);
    }
}
