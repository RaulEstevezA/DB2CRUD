using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using CatalogApi.Common;

namespace CatalogApi.Dtos;

/// <summary>Body of a request that creates or replaces an item.</summary>
public sealed class ItemCreate : Payload
{
    [JsonPropertyName("name")]
    [MinLength(3)]
    [MaxLength(120)]
    public string? Name { get; set { field = value; Mark("name"); } }

    [JsonPropertyName("price")]
    [Range(0.0, double.MaxValue)]
    public decimal? Price { get; set { field = value; Mark("price"); } }

    [JsonPropertyName("supplierEmail")]
    [EmailAddress]
    public string? SupplierEmail { get; set { field = value; Mark("supplierEmail"); } }

    [JsonPropertyName("categoryId")]
    public long? CategoryId { get; set { field = value; Mark("categoryId"); } }

    [JsonPropertyName("stock")]
    [Range(0.0, double.MaxValue)]
    public int? Stock { get; set { field = value; Mark("stock"); } }

    protected override string[] RequiredFields => ["name", "price", "supplierEmail", "categoryId", "stock"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("name", Name), ("price", Price), ("supplierEmail", SupplierEmail), ("categoryId", CategoryId), ("stock", Stock)];
}
