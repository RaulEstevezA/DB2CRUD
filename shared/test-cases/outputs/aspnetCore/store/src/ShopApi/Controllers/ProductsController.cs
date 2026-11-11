using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Services;

namespace ShopApi.Controllers;

/// <summary>Routes of products: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class ProductsController(ProductService service) : ControllerBase
{
    /// <summary>List products.</summary>
    [HttpGet("/products")]
    public async Task<IActionResult> ListProducts(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListProductsAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<ProductResponse>([.. result.Items.Select(ProductResponse.From)], result.Total, page, size));
    }

    /// <summary>Get a product.</summary>
    [HttpGet("/products/{id}")]
    public async Task<IActionResult> GetProduct([FromRoute(Name = "id")] long key)
    {
        return StatusCode(200, ProductResponse.From(await service.GetProductAsync(key)));
    }

    /// <summary>Create a product.</summary>
    [HttpPost("/products")]
    public async Task<IActionResult> CreateProduct([FromBody] ProductCreate data)
    {
        return StatusCode(201, ProductResponse.From(await service.CreateProductAsync(data)));
    }

    /// <summary>Replace a product.</summary>
    [HttpPut("/products/{id}")]
    public async Task<IActionResult> ReplaceProduct(
        [FromRoute(Name = "id")] long key,
        [FromBody] ProductCreate data)
    {
        return StatusCode(200, ProductResponse.From(await service.ReplaceProductAsync(key, data)));
    }

    /// <summary>Update part of a product.</summary>
    [HttpPatch("/products/{id}")]
    public async Task<IActionResult> UpdateProduct(
        [FromRoute(Name = "id")] long key,
        [FromBody] ProductUpdate data)
    {
        return StatusCode(200, ProductResponse.From(await service.UpdateProductAsync(key, data)));
    }

    /// <summary>Delete a product.</summary>
    [HttpDelete("/products/{id}")]
    public async Task<IActionResult> DeleteProduct([FromRoute(Name = "id")] long key)
    {
        await service.DeleteProductAsync(key);
        return StatusCode(204);
    }
}
