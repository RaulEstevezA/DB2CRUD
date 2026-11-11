using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Models;
using ShopApi.Repositories;

namespace ShopApi.Services;

/// <summary>Rules of customers: what each operation checks and changes.</summary>
public sealed class CustomerService(ICustomerRepository repository)
{
    private async Task<Customer> FindAsync(long key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("customer");

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Customer item, CustomerCreate data)
    {
        item.Name = data.Name;
        item.Email = data.Email;
        item.Password = data.Password;
        item.Phone = data.Phone;
        item.Address = data.Address;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Customer item, CustomerUpdate data)
    {
        if (data.Has("name"))
        {
            item.Name = data.Name;
        }
        if (data.Has("email"))
        {
            item.Email = data.Email;
        }
        if (data.Has("password"))
        {
            item.Password = data.Password;
        }
        if (data.Has("phone"))
        {
            item.Phone = data.Phone;
        }
        if (data.Has("address"))
        {
            item.Address = data.Address;
        }
    }

    /// <summary>List customers.</summary>
    public Task<ListResult<Customer>> ListCustomersAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get a customer.</summary>
    public Task<Customer> GetCustomerAsync(long key) => FindAsync(key);

    /// <summary>Create a customer.</summary>
    public async Task<Customer> CreateCustomerAsync(CustomerCreate data)
    {
        var item = new Customer();
        Apply(item, data);
        item.CreatedAt = Clock.Now();
        return await repository.AddAsync(item);
    }

    /// <summary>Replace a customer: every field the client may send takes the value of the body.</summary>
    public async Task<Customer> ReplaceCustomerAsync(long key, CustomerCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of a customer: only the fields in the body change.</summary>
    public async Task<Customer> UpdateCustomerAsync(long key, CustomerUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete a customer.</summary>
    public async Task DeleteCustomerAsync(long key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
