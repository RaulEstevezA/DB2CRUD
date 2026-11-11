using System.Collections.Concurrent;
using ShopApi.Common;
using ShopApi.Models;

namespace ShopApi.Repositories;

/// <summary>Keeps products in memory: they are lost when the application stops. Use it to try the API.</summary>
public sealed class InMemoryProductRepository : IProductRepository
{
    private readonly ConcurrentDictionary<long, Product> items = new();

    private long lastKey;

    /// <summary>The value of a field by its JSON name, for filters and sorting.</summary>
    private static object? Value(Product item, string field) => field switch
    {
        "id" => item.Id,
        "sku" => item.Sku,
        "name" => item.Name,
        "description" => item.Description,
        "price" => item.Price,
        "stock" => item.Stock,
        "active" => item.Active,
        _ => null,
    };

    public Task<ListResult<Product>> ListAsync(ListQuery query)
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
        return Task.FromResult(new ListResult<Product>(window, found.Count));
    }

    public Task<Product?> GetAsync(long key) =>
        Task.FromResult(items.TryGetValue(key, out var item) ? JsonValues.Copy(item) : null);

    public Task<Product> AddAsync(Product item)
    {
        item.Id = Interlocked.Increment(ref lastKey);
        items[item.Id] = JsonValues.Copy(item);
        return Task.FromResult(item);
    }

    public Task<Product> UpdateAsync(Product item)
    {
        items[item.Id] = JsonValues.Copy(item);
        return Task.FromResult(item);
    }

    public Task DeleteAsync(long key)
    {
        items.TryRemove(key, out _);
        return Task.CompletedTask;
    }
}
