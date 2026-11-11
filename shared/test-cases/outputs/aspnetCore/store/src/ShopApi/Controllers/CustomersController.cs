using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Services;

namespace ShopApi.Controllers;

/// <summary>Routes of customers: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class CustomersController(CustomerService service) : ControllerBase
{
    /// <summary>List customers.</summary>
    [HttpGet("/customers")]
    public async Task<IActionResult> ListCustomers(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListCustomersAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<CustomerResponse>([.. result.Items.Select(CustomerResponse.From)], result.Total, page, size));
    }

    /// <summary>Get a customer.</summary>
    [HttpGet("/customers/{id}")]
    public async Task<IActionResult> GetCustomer([FromRoute(Name = "id")] long key)
    {
        return StatusCode(200, CustomerResponse.From(await service.GetCustomerAsync(key)));
    }

    /// <summary>Create a customer.</summary>
    [HttpPost("/customers")]
    public async Task<IActionResult> CreateCustomer([FromBody] CustomerCreate data)
    {
        return StatusCode(201, CustomerResponse.From(await service.CreateCustomerAsync(data)));
    }

    /// <summary>Replace a customer.</summary>
    [HttpPut("/customers/{id}")]
    public async Task<IActionResult> ReplaceCustomer(
        [FromRoute(Name = "id")] long key,
        [FromBody] CustomerCreate data)
    {
        return StatusCode(200, CustomerResponse.From(await service.ReplaceCustomerAsync(key, data)));
    }

    /// <summary>Update part of a customer.</summary>
    [HttpPatch("/customers/{id}")]
    public async Task<IActionResult> UpdateCustomer(
        [FromRoute(Name = "id")] long key,
        [FromBody] CustomerUpdate data)
    {
        return StatusCode(200, CustomerResponse.From(await service.UpdateCustomerAsync(key, data)));
    }

    /// <summary>Delete a customer.</summary>
    [HttpDelete("/customers/{id}")]
    public async Task<IActionResult> DeleteCustomer([FromRoute(Name = "id")] long key)
    {
        await service.DeleteCustomerAsync(key);
        return StatusCode(204);
    }
}
