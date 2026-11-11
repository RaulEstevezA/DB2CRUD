using System.Text.Json.Serialization;
using ShopApi.Models;

namespace ShopApi.Dtos;

/// <summary>A customer as the API returns it.</summary>
public sealed record CustomerResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("email")] string? Email,
    [property: JsonPropertyName("phone"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Phone,
    [property: JsonPropertyName("address")] Address? Address,
    [property: JsonPropertyName("createdAt")] DateTimeOffset? CreatedAt
)
{
    /// <summary>The response of a stored customer: everything but what clients only send.</summary>
    public static CustomerResponse From(Customer item) =>
        new(item.Id, item.Name, item.Email, item.Phone, item.Address, item.CreatedAt);
}
