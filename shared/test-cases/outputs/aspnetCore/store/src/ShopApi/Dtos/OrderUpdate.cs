using System.Text.Json.Serialization;
using ShopApi.Common;
using ShopApi.Models;

namespace ShopApi.Dtos;

/// <summary>Body of a request that changes part of an order: only the fields sent change.</summary>
public sealed class OrderUpdate : Payload
{
    [JsonPropertyName("customerId")]
    public long? CustomerId { get; set { field = value; Mark("customerId"); } }

    [JsonPropertyName("lines")]
    public List<OrderLine>? Lines { get; set { field = value; Mark("lines"); } }

    [JsonPropertyName("status")]
    public OrderStatus? Status { get; set { field = value; Mark("status"); } }

    [JsonPropertyName("total")]
    public double? Total { get; set { field = value; Mark("total"); } }

    [JsonPropertyName("notes")]
    public string? Notes { get; set { field = value; Mark("notes"); } }

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("customerId", CustomerId), ("lines", Lines), ("status", Status), ("total", Total)];
}
