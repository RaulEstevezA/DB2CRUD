using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Models;
using ShopApi.Repositories;

namespace ShopApi.Services;

/// <summary>Rules of orders: what each operation checks and changes.</summary>
public sealed class OrderService(IOrderRepository repository, ICustomerRepository customerRepository, IProductRepository productRepository)
{
    private async Task<Order> FindAsync(long key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("order");

    /// <summary>Every reference must point to a stored item.</summary>
    private async Task CheckReferencesAsync(Order item)
    {
        if (item.CustomerId is { } reference0 && await customerRepository.GetAsync(reference0) is null)
        {
            throw ApiException.Invalid("customerId", "No Customer has this key");
        }
        foreach (var item0 in item.Lines ?? [])
        {
            if (item0.ProductId is { } reference1 && await productRepository.GetAsync(reference1) is null)
            {
                throw ApiException.Invalid("lines.productId", "No Product has this key");
            }
        }
    }

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Order item, OrderCreate data)
    {
        item.CustomerId = data.CustomerId;
        item.Lines = data.Lines;
        item.Status = data.Status;
        item.Total = data.Total;
        item.Notes = data.Notes;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Order item, OrderUpdate data)
    {
        if (data.Has("customerId"))
        {
            item.CustomerId = data.CustomerId;
        }
        if (data.Has("lines"))
        {
            item.Lines = data.Lines;
        }
        if (data.Has("status"))
        {
            item.Status = data.Status;
        }
        if (data.Has("total"))
        {
            item.Total = data.Total;
        }
        if (data.Has("notes"))
        {
            item.Notes = data.Notes;
        }
    }

    /// <summary>List orders.</summary>
    public Task<ListResult<Order>> ListOrdersAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get an order.</summary>
    public Task<Order> GetOrderAsync(long key) => FindAsync(key);

    /// <summary>Create an order.</summary>
    public async Task<Order> CreateOrderAsync(OrderCreate data)
    {
        var item = new Order();
        Apply(item, data);
        await CheckReferencesAsync(item);
        item.CreatedAt = Clock.Now();
        item.UpdatedAt = Clock.Now();
        return await repository.AddAsync(item);
    }

    /// <summary>Replace an order: every field the client may send takes the value of the body.</summary>
    public async Task<Order> ReplaceOrderAsync(long key, OrderCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        await CheckReferencesAsync(item);
        item.UpdatedAt = Clock.Now();
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of an order: only the fields in the body change.</summary>
    public async Task<Order> UpdateOrderAsync(long key, OrderUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        await CheckReferencesAsync(item);
        item.UpdatedAt = Clock.Now();
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete an order.</summary>
    public async Task DeleteOrderAsync(long key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
