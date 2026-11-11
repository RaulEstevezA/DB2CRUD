using LibraryApi.Common;
using LibraryApi.Models;

namespace LibraryApi.Repositories;

/// <summary>Where authors are kept. The service depends only on this interface.</summary>
public interface IAuthorRepository
{
    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>
    Task<ListResult<Author>> ListAsync(ListQuery query);

    /// <summary>The item with this key, or null when there is none.</summary>
    Task<Author?> GetAsync(Guid key);

    /// <summary>Stores a new item and assigns its key; returns it as stored.</summary>
    Task<Author> AddAsync(Author item);

    /// <summary>Stores the new state of an existing item and returns it.</summary>
    Task<Author> UpdateAsync(Author item);

    /// <summary>Removes an existing item.</summary>
    Task DeleteAsync(Guid key);
}
