using System.Text.Json.Serialization;
using ShopApi.Models;

namespace ShopApi.Dtos;

/// <summary>A product as the API returns it.</summary>
public sealed record ProductResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("sku")] string? Sku,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("description"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description,
    [property: JsonPropertyName("price")] double? Price,
    [property: JsonPropertyName("stock")] double? Stock,
    [property: JsonPropertyName("active")] bool? Active
)
{
    /// <summary>The response of a stored product: everything but what clients only send.</summary>
    public static ProductResponse From(Product item) =>
        new(item.Id, item.Sku, item.Name, item.Description, item.Price, item.Stock, item.Active);
}
