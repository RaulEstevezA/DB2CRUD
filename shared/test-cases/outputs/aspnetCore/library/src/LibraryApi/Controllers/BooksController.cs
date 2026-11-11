using System.ComponentModel.DataAnnotations;
using LibraryApi.Common;
using LibraryApi.Dtos;
using LibraryApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace LibraryApi.Controllers;

/// <summary>Routes of books: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class BooksController(BookService service) : ControllerBase
{
    /// <summary>List books.</summary>
    [HttpGet("/books")]
    public async Task<IActionResult> ListBooks(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListBooksAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<BookResponse>([.. result.Items.Select(BookResponse.From)], result.Total, page, size));
    }

    /// <summary>Get a book.</summary>
    [HttpGet("/books/{id}")]
    public async Task<IActionResult> GetBook([FromRoute(Name = "id")] Guid key)
    {
        return StatusCode(200, BookResponse.From(await service.GetBookAsync(key)));
    }

    /// <summary>Create a book.</summary>
    [HttpPost("/books")]
    public async Task<IActionResult> CreateBook([FromBody] BookCreate data)
    {
        return StatusCode(201, BookResponse.From(await service.CreateBookAsync(data)));
    }

    /// <summary>Replace a book.</summary>
    [HttpPut("/books/{id}")]
    public async Task<IActionResult> ReplaceBook(
        [FromRoute(Name = "id")] Guid key,
        [FromBody] BookCreate data)
    {
        return StatusCode(200, BookResponse.From(await service.ReplaceBookAsync(key, data)));
    }

    /// <summary>Update part of a book.</summary>
    [HttpPatch("/books/{id}")]
    public async Task<IActionResult> UpdateBook(
        [FromRoute(Name = "id")] Guid key,
        [FromBody] BookUpdate data)
    {
        return StatusCode(200, BookResponse.From(await service.UpdateBookAsync(key, data)));
    }

    /// <summary>Delete a book.</summary>
    [HttpDelete("/books/{id}")]
    public async Task<IActionResult> DeleteBook([FromRoute(Name = "id")] Guid key)
    {
        await service.DeleteBookAsync(key);
        return StatusCode(204);
    }
}
