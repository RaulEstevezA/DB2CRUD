using ShopApi.Common;
using ShopApi.Models;

namespace ShopApi.Repositories;

/// <summary>Where customers are kept. The service depends only on this interface.</summary>
public interface ICustomerRepository
{
    /// <summary>Items equal to every filter, in order, within the window; and how many match.</summary>
    Task<ListResult<Customer>> ListAsync(ListQuery query);

    /// <summary>The item with this key, or null when there is none.</summary>
    Task<Customer?> GetAsync(long key);

    /// <summary>Stores a new item and assigns its key; returns it as stored.</summary>
    Task<Customer> AddAsync(Customer item);

    /// <summary>Stores the new state of an existing item and returns it.</summary>
    Task<Customer> UpdateAsync(Customer item);

    /// <summary>Removes an existing item.</summary>
    Task DeleteAsync(long key);
}
