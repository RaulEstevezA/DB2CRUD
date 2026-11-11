namespace ShopApi.Models;

/// <summary>An order as the service and its storage handle it.</summary>
public class Order
{
    public long Id { get; set; }

    public long? CustomerId { get; set; }

    public List<OrderLine>? Lines { get; set; }

    public OrderStatus? Status { get; set; }

    public double? Total { get; set; }

    public string? Notes { get; set; }

    public DateTimeOffset? CreatedAt { get; set; }

    public DateTimeOffset? UpdatedAt { get; set; }
}
