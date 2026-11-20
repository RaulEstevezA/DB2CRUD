// Entities written by Model2DB from Book. Review them before using them.
using System;
using System.Collections.Generic;

namespace Example.Data;

public enum Genre
{
    Novel,
    Essay,
    Poetry,
    Science,
}

/// <summary>The values of <see cref="Genre"/> as the database stores them.</summary>
public static class GenreValues
{
    public static string ToValue(Genre value) => value switch
    {
        Genre.Novel => "novel",
        Genre.Essay => "essay",
        Genre.Poetry => "poetry",
        Genre.Science => "science",
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };

    public static Genre FromValue(string value) => value switch
    {
        "novel" => Genre.Novel,
        "essay" => Genre.Essay,
        "poetry" => Genre.Poetry,
        "science" => Genre.Science,
        _ => throw new ArgumentOutOfRangeException(nameof(value)),
    };
}

public class Author
{
    public Guid Id { get; set; }
    public string Name { get; set; } = null!;
    public string? Email { get; set; }
    public DateOnly? Born { get; set; }
}

// TODO: does the application read "Book" by author, ordered by published desc? Accept the query in the design to index it.
public class Book
{
    public Guid Id { get; set; }
    public string Title { get; set; } = null!;
    public string Isbn { get; set; } = null!;
    public Genre Genre { get; set; }
    public int Pages { get; set; }
    public DateOnly? Published { get; set; }
    public bool Available { get; set; } = true;
    public Guid AuthorId { get; set; }
    public Author Author { get; set; } = null!;
}
