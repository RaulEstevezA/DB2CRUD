using System.Collections.Concurrent;
using LibraryApi.Common;
using LibraryApi.Models;

namespace LibraryApi.Repositories;

/// <summary>Keeps books in memory: they are lost when the application stops. Use it to try the API.</summary>
public sealed class InMemoryBookRepository : IBookRepository
{
    private readonly ConcurrentDictionary<Guid, Book> items = new();

    /// <summary>The value of a field by its JSON name, for filters and sorting.</summary>
    private static object? Value(Book item, string field) => field switch
    {
        "id" => item.Id,
        "title" => item.Title,
        "isbn" => item.Isbn,
        "authorId" => item.AuthorId,
        "genre" => item.Genre,
        "pages" => item.Pages,
        "published" => item.Published,
        "available" => item.Available,
        _ => null,
    };

    public Task<ListResult<Book>> ListAsync(ListQuery query)
    {
        var found = items.Values
            .Where(item => query.Filters.All(filter => Equals(Value(item, filter.Key), filter.Value)))
            .OrderBy(item => item.Id)
            .ToList();
        if (query.SortField is { } field)
        {
            var present = found.Where(item => Value(item, field) is not null);
            var sorted = query.Descending
                ? present.OrderByDescending(item => Value(item, field), Comparer<object?>.Default)
                : present.OrderBy(item => Value(item, field), Comparer<object?>.Default);
            // Items without a value go last, whatever the order
            found = [.. sorted, .. found.Where(item => Value(item, field) is null)];
        }
        var window = found.Skip(query.Offset).Take(query.Limit ?? int.MaxValue).Select(item => JsonValues.Copy(item)).ToList();
        return Task.FromResult(new ListResult<Book>(window, found.Count));
    }

    public Task<Book?> GetAsync(Guid key) =>
        Task.FromResult(items.TryGetValue(key, out var item) ? JsonValues.Copy(item) : null);

    public Task<Book> AddAsync(Book item)
    {
        item.Id = Guid.NewGuid();
        items[item.Id] = JsonValues.Copy(item);
        return Task.FromResult(item);
    }

    public Task<Book> UpdateAsync(Book item)
    {
        items[item.Id] = JsonValues.Copy(item);
        return Task.FromResult(item);
    }

    public Task DeleteAsync(Guid key)
    {
        items.TryRemove(key, out _);
        return Task.CompletedTask;
    }
}
