using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using LibraryApi.Common;
using LibraryApi.Models;

namespace LibraryApi.Dtos;

/// <summary>Body of a request that creates or replaces a book.</summary>
public sealed class BookCreate : Payload
{
    [JsonPropertyName("title")]
    [MinLength(1)]
    [MaxLength(200)]
    public string? Title { get; set { field = value; Mark("title"); } }

    [JsonPropertyName("isbn")]
    [Pattern("^[0-9]{13}$")]
    public string? Isbn { get; set { field = value; Mark("isbn"); } }

    [JsonPropertyName("authorId")]
    public Guid? AuthorId { get; set { field = value; Mark("authorId"); } }

    [JsonPropertyName("genre")]
    public Genre? Genre { get; set { field = value; Mark("genre"); } }

    [JsonPropertyName("pages")]
    [Range(1.0, 5000.0)]
    public int? Pages { get; set { field = value; Mark("pages"); } }

    [JsonPropertyName("published")]
    public DateOnly? Published { get; set { field = value; Mark("published"); } }

    [JsonPropertyName("available")]
    public bool? Available { get; set { field = value; Mark("available"); } }

    protected override string[] RequiredFields => ["title", "isbn", "authorId", "genre", "pages"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("title", Title), ("isbn", Isbn), ("authorId", AuthorId), ("genre", Genre), ("pages", Pages), ("available", Available)];
}
