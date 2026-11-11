using System.Text.Json.Serialization;
using CatalogApi.Models;

namespace CatalogApi.Dtos;

/// <summary>An item as the API returns it.</summary>
public sealed record ItemResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("price")] decimal? Price,
    [property: JsonPropertyName("supplierEmail")] string? SupplierEmail,
    [property: JsonPropertyName("categoryId")] long? CategoryId,
    [property: JsonPropertyName("stock")] int? Stock
)
{
    /// <summary>The response of a stored item: everything but what clients only send.</summary>
    public static ItemResponse From(Item item) =>
        new(item.Id, item.Name, item.Price, item.SupplierEmail, item.CategoryId, item.Stock);
}
