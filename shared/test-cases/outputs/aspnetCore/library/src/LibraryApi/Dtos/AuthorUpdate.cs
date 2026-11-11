using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using LibraryApi.Common;

namespace LibraryApi.Dtos;

/// <summary>Body of a request that changes part of an author: only the fields sent change.</summary>
public sealed class AuthorUpdate : Payload
{
    [JsonPropertyName("name")]
    [MinLength(2)]
    [MaxLength(120)]
    public string? Name { get; set { field = value; Mark("name"); } }

    [JsonPropertyName("email")]
    [EmailAddress]
    public string? Email { get; set { field = value; Mark("email"); } }

    [JsonPropertyName("born")]
    public DateOnly? Born { get; set { field = value; Mark("born"); } }

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("name", Name)];
}
