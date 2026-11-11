using LibraryApi.Common;
using LibraryApi.Models;

namespace LibraryApi.Repositories;

/// <summary>Where books are kept. The service depends only on this interface.</summary>
public interface IBookRepository
{
    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>
    Task<ListResult<Book>> ListAsync(ListQuery query);

    /// <summary>The item with this key, or null when there is none.</summary>
    Task<Book?> GetAsync(Guid key);

    /// <summary>Stores a new item and assigns its key; returns it as stored.</summary>
    Task<Book> AddAsync(Book item);

    /// <summary>Stores the new state of an existing item and returns it.</summary>
    Task<Book> UpdateAsync(Book item);

    /// <summary>Removes an existing item.</summary>
    Task DeleteAsync(Guid key);
}
