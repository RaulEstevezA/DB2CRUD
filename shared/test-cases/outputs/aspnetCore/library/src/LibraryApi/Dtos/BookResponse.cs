using System.Text.Json.Serialization;
using LibraryApi.Models;

namespace LibraryApi.Dtos;

/// <summary>A book as the API returns it.</summary>
public sealed record BookResponse(
    [property: JsonPropertyName("id")] Guid Id,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("isbn")] string? Isbn,
    [property: JsonPropertyName("authorId")] Guid? AuthorId,
    [property: JsonPropertyName("genre")] Genre? Genre,
    [property: JsonPropertyName("pages")] int? Pages,
    [property: JsonPropertyName("published")] DateOnly? Published,
    [property: JsonPropertyName("available")] bool? Available
)
{
    /// <summary>The response of a stored book: everything but what clients only send.</summary>
    public static BookResponse From(Book item) =>
        new(item.Id, item.Title, item.Isbn, item.AuthorId, item.Genre, item.Pages, item.Published, item.Available);
}
