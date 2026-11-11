using System.ComponentModel.DataAnnotations;
using LibraryApi.Common;
using LibraryApi.Dtos;
using LibraryApi.Services;
using Microsoft.AspNetCore.Mvc;

namespace LibraryApi.Controllers;

/// <summary>Routes of authors: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class AuthorsController(AuthorService service) : ControllerBase
{
    /// <summary>List authors.</summary>
    [HttpGet("/authors")]
    public async Task<IActionResult> ListAuthors(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListAuthorsAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<AuthorResponse>([.. result.Items.Select(AuthorResponse.From)], result.Total, page, size));
    }

    /// <summary>Get an author.</summary>
    [HttpGet("/authors/{id}")]
    public async Task<IActionResult> GetAuthor([FromRoute(Name = "id")] Guid key)
    {
        return StatusCode(200, AuthorResponse.From(await service.GetAuthorAsync(key)));
    }

    /// <summary>Create an author.</summary>
    [HttpPost("/authors")]
    public async Task<IActionResult> CreateAuthor([FromBody] AuthorCreate data)
    {
        return StatusCode(201, AuthorResponse.From(await service.CreateAuthorAsync(data)));
    }

    /// <summary>Replace an author.</summary>
    [HttpPut("/authors/{id}")]
    public async Task<IActionResult> ReplaceAuthor(
        [FromRoute(Name = "id")] Guid key,
        [FromBody] AuthorCreate data)
    {
        return StatusCode(200, AuthorResponse.From(await service.ReplaceAuthorAsync(key, data)));
    }

    /// <summary>Update part of an author.</summary>
    [HttpPatch("/authors/{id}")]
    public async Task<IActionResult> UpdateAuthor(
        [FromRoute(Name = "id")] Guid key,
        [FromBody] AuthorUpdate data)
    {
        return StatusCode(200, AuthorResponse.From(await service.UpdateAuthorAsync(key, data)));
    }

    /// <summary>Delete an author.</summary>
    [HttpDelete("/authors/{id}")]
    public async Task<IActionResult> DeleteAuthor([FromRoute(Name = "id")] Guid key)
    {
        await service.DeleteAuthorAsync(key);
        return StatusCode(204);
    }
}
