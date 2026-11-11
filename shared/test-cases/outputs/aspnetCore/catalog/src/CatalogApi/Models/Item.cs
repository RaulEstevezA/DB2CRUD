namespace CatalogApi.Models;

/// <summary>An item as the service and its storage handle it.</summary>
public class Item
{
    public long Id { get; set; }

    public string? Name { get; set; }

    public decimal? Price { get; set; }

    public string? SupplierEmail { get; set; }

    public long? CategoryId { get; set; }

    public int? Stock { get; set; }
}
