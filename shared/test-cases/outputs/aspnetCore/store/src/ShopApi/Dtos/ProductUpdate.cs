using System.Text.Json.Serialization;
using ShopApi.Common;

namespace ShopApi.Dtos;

/// <summary>Body of a request that changes part of a product: only the fields sent change.</summary>
public sealed class ProductUpdate : Payload
{
    [JsonPropertyName("sku")]
    public string? Sku { get; set { field = value; Mark("sku"); } }

    [JsonPropertyName("name")]
    public string? Name { get; set { field = value; Mark("name"); } }

    [JsonPropertyName("description")]
    public string? Description { get; set { field = value; Mark("description"); } }

    [JsonPropertyName("price")]
    public double? Price { get; set { field = value; Mark("price"); } }

    [JsonPropertyName("stock")]
    public double? Stock { get; set { field = value; Mark("stock"); } }

    [JsonPropertyName("active")]
    public bool? Active { get; set { field = value; Mark("active"); } }

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("sku", Sku), ("name", Name), ("description", Description), ("price", Price), ("stock", Stock), ("active", Active)];
}
