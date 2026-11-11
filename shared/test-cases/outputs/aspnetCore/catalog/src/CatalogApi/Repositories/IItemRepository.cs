using CatalogApi.Common;
using CatalogApi.Models;

namespace CatalogApi.Repositories;

/// <summary>Where items are kept. The service depends only on this interface.</summary>
public interface IItemRepository
{
    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>
    Task<ListResult<Item>> ListAsync(ListQuery query);

    /// <summary>The item with this key, or null when there is none.</summary>
    Task<Item?> GetAsync(long key);

    /// <summary>Stores a new item and assigns its key; returns it as stored.</summary>
    Task<Item> AddAsync(Item item);

    /// <summary>Stores the new state of an existing item and returns it.</summary>
    Task<Item> UpdateAsync(Item item);

    /// <summary>Removes an existing item.</summary>
    Task DeleteAsync(long key);
}
