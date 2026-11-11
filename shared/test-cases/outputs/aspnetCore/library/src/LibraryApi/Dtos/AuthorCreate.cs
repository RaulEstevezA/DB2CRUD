using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using LibraryApi.Common;

namespace LibraryApi.Dtos;

/// <summary>Body of a request that creates or replaces an author.</summary>
public sealed class AuthorCreate : Payload
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

    protected override string[] RequiredFields => ["name"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("name", Name)];
}
