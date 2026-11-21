namespace Shop.Models;

/// <summary>A customer of the shop</summary>
public class Customer
{
    public long Id { get; set; }
    public string Email { get; set; } = "";
    public string PasswordHash { get; set; } = "";
    public DateTimeOffset CreatedAt { get; set; }
}

public record CategoryDto(int Id, string Name);

public class Product
{
    public long Id { get; init; }
    public required string Name { get; init; }
    public decimal Price { get; init; }
    public required string Status { get; init; }
    public required string CategoryName { get; init; }
    public List<int> TagIds { get; init; } = [];
}

public class TagEntity
{
    public int Id { get; set; }
    public string Label { get; set; } = "";
}
