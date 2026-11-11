using System.Text.Json.Serialization;
using ShopApi.Models;

namespace ShopApi.Dtos;

/// <summary>An order as the API returns it.</summary>
public sealed record OrderResponse(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("customerId")] long? CustomerId,
    [property: JsonPropertyName("lines")] List<OrderLine>? Lines,
    [property: JsonPropertyName("status")] OrderStatus? Status,
    [property: JsonPropertyName("total")] double? Total,
    [property: JsonPropertyName("notes"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Notes,
    [property: JsonPropertyName("createdAt")] DateTimeOffset? CreatedAt,
    [property: JsonPropertyName("updatedAt")] DateTimeOffset? UpdatedAt
)
{
    /// <summary>The response of a stored order: everything but what clients only send.</summary>
    public static OrderResponse From(Order item) =>
        new(item.Id, item.CustomerId, item.Lines, item.Status, item.Total, item.Notes, item.CreatedAt, item.UpdatedAt);
}
