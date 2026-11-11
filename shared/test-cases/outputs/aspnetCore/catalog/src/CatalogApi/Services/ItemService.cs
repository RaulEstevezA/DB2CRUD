using CatalogApi.Common;
using CatalogApi.Dtos;
using CatalogApi.Models;
using CatalogApi.Repositories;

namespace CatalogApi.Services;

/// <summary>Rules of items: what each operation checks and changes.</summary>
public sealed class ItemService(IItemRepository repository, ICategoryRepository categoryRepository)
{
    private async Task<Item> FindAsync(long key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("item");

    /// <summary>Every reference must point to a stored item.</summary>
    private async Task CheckReferencesAsync(Item item)
    {
        if (item.CategoryId is { } reference0 && await categoryRepository.GetAsync(reference0) is null)
        {
            throw ApiException.Invalid("categoryId", "No Category has this key");
        }
    }

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Item item, ItemCreate data)
    {
        item.Name = data.Name;
        item.Price = data.Price;
        item.SupplierEmail = data.SupplierEmail;
        item.CategoryId = data.CategoryId;
        item.Stock = data.Stock;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Item item, ItemUpdate data)
    {
        if (data.Has("name"))
        {
            item.Name = data.Name;
        }
        if (data.Has("price"))
        {
            item.Price = data.Price;
        }
        if (data.Has("supplierEmail"))
        {
            item.SupplierEmail = data.SupplierEmail;
        }
        if (data.Has("categoryId"))
        {
            item.CategoryId = data.CategoryId;
        }
        if (data.Has("stock"))
        {
            item.Stock = data.Stock;
        }
    }

    /// <summary>List items.</summary>
    public Task<ListResult<Item>> ListItemsAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get an item.</summary>
    public Task<Item> GetItemAsync(long key) => FindAsync(key);

    /// <summary>Create an item.</summary>
    public async Task<Item> CreateItemAsync(ItemCreate data)
    {
        var item = new Item();
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.AddAsync(item);
    }

    /// <summary>Replace an item: every field the client may send takes the value of the body.</summary>
    public async Task<Item> ReplaceItemAsync(long key, ItemCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of an item: only the fields in the body change.</summary>
    public async Task<Item> UpdateItemAsync(long key, ItemUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete an item.</summary>
    public async Task DeleteItemAsync(long key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
