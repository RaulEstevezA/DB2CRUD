using System.Text.Json.Serialization;
using LibraryApi.Models;

namespace LibraryApi.Dtos;

/// <summary>An author as the API returns it.</summary>
public sealed record AuthorResponse(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("born")] DateOnly? Born
)
{
    /// <summary>The response of a stored author: everything but what clients only send.</summary>
    public static AuthorResponse From(Author item) =>
        new(item.Id, item.Name, item.Email, item.Born);
}
