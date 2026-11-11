using System.Text.Json.Serialization;
using ShopApi.Common;

namespace ShopApi.Models;

/// <summary>Values of OrderStatus, with the value each one has in JSON.</summary>
[JsonConverter(typeof(TextEnumConverter<OrderStatus>))]
public enum OrderStatus
{
    [JsonStringEnumMemberName("pending")]
    Pending,

    [JsonStringEnumMemberName("paid")]
    Paid,

    [JsonStringEnumMemberName("shipped")]
    Shipped,

    [JsonStringEnumMemberName("cancelled")]
    Cancelled,
}
