using System.Text.Json.Serialization;
using ShopApi.Common;
using ShopApi.Models;

namespace ShopApi.Dtos;

/// <summary>Body of a request that creates or replaces a customer.</summary>
public sealed class CustomerCreate : Payload
{
    [JsonPropertyName("name")]
    public string? Name { get; set { field = value; Mark("name"); } }

    [JsonPropertyName("email")]
    public string? Email { get; set { field = value; Mark("email"); } }

    [JsonPropertyName("password")]
    public string? Password { get; set { field = value; Mark("password"); } }

    [JsonPropertyName("phone")]
    public string? Phone { get; set { field = value; Mark("phone"); } }

    [JsonPropertyName("address")]
    public Address? Address { get; set { field = value; Mark("address"); } }

    protected override string[] RequiredFields => ["name", "email", "password", "address"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("name", Name), ("email", Email), ("password", Password), ("phone", Phone), ("address", Address)];
}
