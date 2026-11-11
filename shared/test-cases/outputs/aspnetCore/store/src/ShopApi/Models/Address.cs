using System.Text.Json.Serialization;
using ShopApi.Common;

namespace ShopApi.Models;

/// <summary>Address, embedded in the resources that hold it.</summary>
public sealed class Address : Payload
{
    [JsonPropertyName("street")]
    public string? Street { get; set { field = value; Mark("street"); } }

    [JsonPropertyName("city")]
    public string? City { get; set { field = value; Mark("city"); } }

    [JsonPropertyName("postalCode")]
    public string? PostalCode { get; set { field = value; Mark("postalCode"); } }

    [JsonPropertyName("country")]
    public string? Country { get; set { field = value; Mark("country"); } }

    protected override string[] RequiredFields => ["street", "city", "postalCode", "country"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("street", Street), ("city", City), ("postalCode", PostalCode), ("country", Country)];
}
