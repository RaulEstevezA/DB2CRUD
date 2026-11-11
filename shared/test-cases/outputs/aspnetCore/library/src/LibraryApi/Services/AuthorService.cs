using LibraryApi.Common;
using LibraryApi.Dtos;
using LibraryApi.Models;
using LibraryApi.Repositories;

namespace LibraryApi.Services;

/// <summary>Rules of authors: what each operation checks and changes.</summary>
public sealed class AuthorService(IAuthorRepository repository)
{
    private async Task<Author> FindAsync(Guid key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("author");

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Author item, AuthorCreate data)
    {
        item.Name = data.Name;
        item.Email = data.Has("email") ? data.Email : null;
        item.Born = data.Has("born") ? data.Born : null;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Author item, AuthorUpdate data)
    {
        if (data.Has("name"))
        {
            item.Name = data.Name;
        }
        if (data.Has("email"))
        {
            item.Email = data.Email;
        }
        if (data.Has("born"))
        {
            item.Born = data.Born;
        }
    }

    /// <summary>List authors.</summary>
    public Task<ListResult<Author>> ListAuthorsAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get an author.</summary>
    public Task<Author> GetAuthorAsync(Guid key) => FindAsync(key);

    /// <summary>Create an author.</summary>
    public async Task<Author> CreateAuthorAsync(AuthorCreate data)
    {
        var item = new Author();
        Apply(item, data);
        return await repository.AddAsync(item);
    }

    /// <summary>Replace an author: every field the client may send takes the value of the body.</summary>
    public async Task<Author> ReplaceAuthorAsync(Guid key, AuthorCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of an author: only the fields in the body change.</summary>
    public async Task<Author> UpdateAuthorAsync(Guid key, AuthorUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete an author.</summary>
    public async Task DeleteAuthorAsync(Guid key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
