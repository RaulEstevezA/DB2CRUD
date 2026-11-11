using ShopApi.Common;
using ShopApi.Models;

namespace ShopApi.Repositories;

/// <summary>Where products are kept. The service depends only on this interface.</summary>
public interface IProductRepository
{
    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>
    Task<ListResult<Product>> ListAsync(ListQuery query);

    /// <summary>The item with this key, or null when there is none.</summary>
    Task<Product?> GetAsync(long key);

    /// <summary>Stores a new item and assigns its key; returns it as stored.</summary>
    Task<Product> AddAsync(Product item);

    /// <summary>Stores the new state of an existing item and returns it.</summary>
    Task<Product> UpdateAsync(Product item);

    /// <summary>Removes an existing item.</summary>
    Task DeleteAsync(long key);
}
