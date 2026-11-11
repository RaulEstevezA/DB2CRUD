namespace LibraryApi.Models;

/// <summary>A book as the service and its storage handle it.</summary>
public class Book
{
    public Guid Id { get; set; }

    public string? Title { get; set; }

    public string? Isbn { get; set; }

    public Guid? AuthorId { get; set; }

    public Genre? Genre { get; set; }

    public int? Pages { get; set; }

    public DateOnly? Published { get; set; }

    public bool? Available { get; set; }
}
