using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using CatalogApi.Common;

namespace CatalogApi.Dtos;

/// <summary>Body of a request that creates or replaces a category.</summary>
public sealed class CategoryCreate : Payload
{
    [JsonPropertyName("name")]
    [MinLength(1)]
    [MaxLength(80)]
    public string? Name { get; set { field = value; Mark("name"); } }

    [JsonPropertyName("parentId")]
    public long? ParentId { get; set { field = value; Mark("parentId"); } }

    protected override string[] RequiredFields => ["name"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("name", Name)];
}
