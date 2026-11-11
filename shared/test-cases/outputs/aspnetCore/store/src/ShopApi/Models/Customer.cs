namespace ShopApi.Models;

/// <summary>A customer as the service and its storage handle it.</summary>
public class Customer
{
    public long Id { get; set; }

    public string? Name { get; set; }

    public string? Email { get; set; }

    public string? Password { get; set; }

    public string? Phone { get; set; }

    public Address? Address { get; set; }

    public DateTimeOffset? CreatedAt { get; set; }
}
