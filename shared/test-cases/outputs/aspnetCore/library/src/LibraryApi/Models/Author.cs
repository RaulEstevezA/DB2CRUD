namespace LibraryApi.Models;

/// <summary>An author as the service and its storage handle it.</summary>
public class Author
{
    public Guid Id { get; set; }

    public string? Name { get; set; }

    public string? Email { get; set; }

    public DateOnly? Born { get; set; }
}
