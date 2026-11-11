using System.Text.Json.Serialization;
using ShopApi.Common;

namespace ShopApi.Models;

/// <summary>OrderLine, embedded in the resources that hold it.</summary>
public sealed class OrderLine : Payload
{
    [JsonPropertyName("productId")]
    public long? ProductId { get; set { field = value; Mark("productId"); } }

    [JsonPropertyName("quantity")]
    public double? Quantity { get; set { field = value; Mark("quantity"); } }

    [JsonPropertyName("unitPrice")]
    public double? UnitPrice { get; set { field = value; Mark("unitPrice"); } }

    protected override string[] RequiredFields => ["productId", "quantity", "unitPrice"];

    protected override IEnumerable<(string Field, object? Value)> NonNullValues() => [("productId", ProductId), ("quantity", Quantity), ("unitPrice", UnitPrice)];
}
