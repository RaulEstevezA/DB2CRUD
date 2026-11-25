using System;
using System.Collections.Generic;

namespace Shop.Models;

public record Location(double Latitude, double Longitude);

public record Address(string Street, string ZipCode, Location? Location);

public record Customer(string Id, string Email, DateTimeOffset Since, Address Address, List<string> Tags);

public class Discount
{
    public string Reason { get; set; } = null!;
    public double Percent { get; set; }
}

public class OrderLine
{
    public string? Id { get; set; }
    public string Sku { get; set; } = null!;
    public int Quantity { get; set; }
    public decimal Price { get; set; }
    public string? Status { get; set; }
    public Discount[] Discounts { get; set; } = null!;
}

public record Shipping(string Carrier, DateOnly SentOn);

public record Order(string Id, string Code, List<OrderLine> Lines, Shipping? Shipping);

public record Parcel(double Weight, string Size, bool Fragile);

public record Shipment(string Id, Parcel Parcel, List<string> Stops);
