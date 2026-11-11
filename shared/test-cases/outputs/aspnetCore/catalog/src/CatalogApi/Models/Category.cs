namespace CatalogApi.Models;

/// <summary>A category as the service and its storage handle it.</summary>
public class Category
{
    public long Id { get; set; }

    public string? Name { get; set; }

    public long? ParentId { get; set; }
}
