using System.Text.Json.Serialization;
using CatalogApi.Models;

namespace CatalogApi.Dtos;

/// <summary>A category as the API returns it.</summary>
public sealed record CategoryResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("parentId"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? ParentId
)
{
    /// <summary>The response of a stored category: everything but what clients only send.</summary>
    public static CategoryResponse From(Category item) =>
        new(item.Id, item.Name, item.ParentId);
}
