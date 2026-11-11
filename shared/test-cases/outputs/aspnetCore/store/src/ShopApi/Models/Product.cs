namespace ShopApi.Models;

/// <summary>A product as the service and its storage handle it.</summary>
public class Product
{
    public long Id { get; set; }

    public string? Sku { get; set; }

    public string? Name { get; set; }

    public string? Description { get; set; }

    public double? Price { get; set; }

    public double? Stock { get; set; }

    public bool? Active { get; set; }
}
