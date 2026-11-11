using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Models;
using ShopApi.Repositories;

namespace ShopApi.Services;

/// <summary>Rules of products: what each operation checks and changes.</summary>
public sealed class ProductService(IProductRepository repository)
{
    private async Task<Product> FindAsync(long key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("product");

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Product item, ProductCreate data)
    {
        item.Sku = data.Sku;
        item.Name = data.Name;
        item.Description = data.Description;
        item.Price = data.Price;
        item.Stock = data.Stock;
        item.Active = data.Active;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Product item, ProductUpdate data)
    {
        if (data.Has("sku"))
        {
            item.Sku = data.Sku;
        }
        if (data.Has("name"))
        {
            item.Name = data.Name;
        }
        if (data.Has("description"))
        {
            item.Description = data.Description;
        }
        if (data.Has("price"))
        {
            item.Price = data.Price;
        }
        if (data.Has("stock"))
        {
            item.Stock = data.Stock;
        }
        if (data.Has("active"))
        {
            item.Active = data.Active;
        }
    }

    /// <summary>List products.</summary>
    public Task<ListResult<Product>> ListProductsAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get a product.</summary>
    public Task<Product> GetProductAsync(long key) => FindAsync(key);

    /// <summary>Create a product.</summary>
    public async Task<Product> CreateProductAsync(ProductCreate data)
    {
        var item = new Product();
        Apply(item, data);
        return await repository.AddAsync(item);
    }

    /// <summary>Replace a product: every field the client may send takes the value of the body.</summary>
    public async Task<Product> ReplaceProductAsync(long key, ProductCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of a product: only the fields in the body change.</summary>
    public async Task<Product> UpdateProductAsync(long key, ProductUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete a product.</summary>
    public async Task DeleteProductAsync(long key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
