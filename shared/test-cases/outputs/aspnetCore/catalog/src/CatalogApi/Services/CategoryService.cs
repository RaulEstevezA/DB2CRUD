using CatalogApi.Common;
using CatalogApi.Dtos;
using CatalogApi.Models;
using CatalogApi.Repositories;

namespace CatalogApi.Services;

/// <summary>Rules of categories: what each operation checks and changes.</summary>
public sealed class CategoryService(ICategoryRepository repository)
{
    private async Task<Category> FindAsync(long key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("category");

    /// <summary>Every reference must point to a stored item.</summary>
    private async Task CheckReferencesAsync(Category item)
    {
        if (item.ParentId is { } reference0 && await repository.GetAsync(reference0) is null)
        {
            throw ApiException.Invalid("parentId", "No Category has this key");
        }
    }

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Category item, CategoryCreate data)
    {
        item.Name = data.Name;
        item.ParentId = data.ParentId;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Category item, CategoryUpdate data)
    {
        if (data.Has("name"))
        {
            item.Name = data.Name;
        }
        if (data.Has("parentId"))
        {
            item.ParentId = data.ParentId;
        }
    }

    /// <summary>List categories.</summary>
    public Task<ListResult<Category>> ListCategoriesAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get a category.</summary>
    public Task<Category> GetCategoryAsync(long key) => FindAsync(key);

    /// <summary>Create a category.</summary>
    public async Task<Category> CreateCategoryAsync(CategoryCreate data)
    {
        var item = new Category();
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.AddAsync(item);
    }

    /// <summary>Replace a category: every field the client may send takes the value of the body.</summary>
    public async Task<Category> ReplaceCategoryAsync(long key, CategoryCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of a category: only the fields in the body change.</summary>
    public async Task<Category> UpdateCategoryAsync(long key, CategoryUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete a category.</summary>
    public async Task DeleteCategoryAsync(long key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
