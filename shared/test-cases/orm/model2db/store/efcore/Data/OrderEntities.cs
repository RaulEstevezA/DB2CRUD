// Entities written by Model2DB from Order. Review them before using them.
using System;
using System.Collections.Generic;

namespace Example.Data;

public enum OrderStatus
{
    Pending,
    Paid,
    Shipped,
    Cancelled,
}

/// <summary>The values of <see cref="OrderStatus"/> as the database stores them.</summary>
public static class OrderStatusValues
{
    public static string ToValue(OrderStatus value) => value switch
    {
        OrderStatus.Pending => "pending",
        OrderStatus.Paid => "paid",
        OrderStatus.Shipped => "shipped",
        OrderStatus.Cancelled => "cancelled",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static OrderStatus FromValue(string value) => value switch
    {
        "pending" => OrderStatus.Pending,
        "paid" => OrderStatus.Paid,
        "shipped" => OrderStatus.Shipped,
        "cancelled" => OrderStatus.Cancelled,
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };
}

public class Customer
{
    public long Id { get; set; }
    public string Name { get; set; } = null!;
    public string Email { get; set; } = null!;
    public string Password { get; set; } = null!;
    public string? Phone { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public string AddressStreet { get; set; } = null!;
    public string AddressCity { get; set; } = null!;
    public string AddressPostalCode { get; set; } = null!;
    public string AddressCountry { get; set; } = null!;
}

public class Product
{
    public long Id { get; set; }
    public string Sku { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string? Description { get; set; }
    public double Price { get; set; }
    public int Stock { get; set; }
    public bool Active { get; set; }
}

public class OrderLine
{
    public long Id { get; set; }
    public int Quantity { get; set; }
    public double UnitPrice { get; set; }
    public long ProductId { get; set; }
    public long OrderId { get; set; }
    public Product Product { get; set; } = null!;
    public Order Order { get; set; } = null!;
}

// TODO: does the application read "Order" by customer, ordered by createdAt desc? Accept the query in the design to index it.
public class Order
{
    public long Id { get; set; }
    public OrderStatus Status { get; set; }
    public double Total { get; set; }
    public string? Notes { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public long CustomerId { get; set; }
    public List<OrderLine> Lines { get; set; } = new();
    public Customer Customer { get; set; } = null!;
}
