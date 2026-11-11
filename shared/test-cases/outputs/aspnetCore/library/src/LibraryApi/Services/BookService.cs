using LibraryApi.Common;
using LibraryApi.Dtos;
using LibraryApi.Models;
using LibraryApi.Repositories;

namespace LibraryApi.Services;

/// <summary>Rules of books: what each operation checks and changes.</summary>
public sealed class BookService(IBookRepository repository, IAuthorRepository authorRepository)
{
    private async Task<Book> FindAsync(Guid key) =>
        await repository.GetAsync(key) ?? throw ApiException.NotFound("book");

    /// <summary>Every reference must point to a stored item.</summary>
    private async Task CheckReferencesAsync(Book item)
    {
        if (item.AuthorId is { } reference0 && await authorRepository.GetAsync(reference0) is null)
        {
            throw ApiException.Invalid("authorId", "No Author has this key");
        }
    }

    /// <summary>Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.</summary>
    private static void Apply(Book item, BookCreate data)
    {
        item.Title = data.Title;
        item.Isbn = data.Isbn;
        item.AuthorId = data.AuthorId;
        item.Genre = data.Genre;
        item.Pages = data.Pages;
        item.Published = data.Has("published") ? data.Published : null;
        item.Available = data.Has("available") ? data.Available : true;
    }

    /// <summary>Sets the fields a partial change carries; the others stay as they are.</summary>
    private static void ApplyChanges(Book item, BookUpdate data)
    {
        if (data.Has("title"))
        {
            item.Title = data.Title;
        }
        if (data.Has("isbn"))
        {
            item.Isbn = data.Isbn;
        }
        if (data.Has("authorId"))
        {
            item.AuthorId = data.AuthorId;
        }
        if (data.Has("genre"))
        {
            item.Genre = data.Genre;
        }
        if (data.Has("pages"))
        {
            item.Pages = data.Pages;
        }
        if (data.Has("published"))
        {
            item.Published = data.Published;
        }
        if (data.Has("available"))
        {
            item.Available = data.Available;
        }
    }

    /// <summary>List books.</summary>
    public Task<ListResult<Book>> ListBooksAsync(ListQuery query) => repository.ListAsync(query);

    /// <summary>Get a book.</summary>
    public Task<Book> GetBookAsync(Guid key) => FindAsync(key);

    /// <summary>Create a book.</summary>
    public async Task<Book> CreateBookAsync(BookCreate data)
    {
        var item = new Book();
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.AddAsync(item);
    }

    /// <summary>Replace a book: every field the client may send takes the value of the body.</summary>
    public async Task<Book> ReplaceBookAsync(Guid key, BookCreate data)
    {
        var item = await FindAsync(key);
        Apply(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Update part of a book: only the fields in the body change.</summary>
    public async Task<Book> UpdateBookAsync(Guid key, BookUpdate data)
    {
        var item = await FindAsync(key);
        ApplyChanges(item, data);
        await CheckReferencesAsync(item);
        return await repository.UpdateAsync(item);
    }

    /// <summary>Delete a book.</summary>
    public async Task DeleteBookAsync(Guid key)
    {
        await FindAsync(key);
        await repository.DeleteAsync(key);
    }
}
