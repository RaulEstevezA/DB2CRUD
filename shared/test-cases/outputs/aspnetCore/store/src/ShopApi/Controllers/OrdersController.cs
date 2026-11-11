using System.ComponentModel.DataAnnotations;
using Microsoft.AspNetCore.Mvc;
using ShopApi.Common;
using ShopApi.Dtos;
using ShopApi.Services;

namespace ShopApi.Controllers;

/// <summary>Routes of orders: HTTP in, service calls, HTTP out.</summary>
[ApiController]
public sealed class OrdersController(OrderService service) : ControllerBase
{
    /// <summary>List orders.</summary>
    [HttpGet("/orders")]
    public async Task<IActionResult> ListOrders(
        [FromQuery, Range(1, int.MaxValue)] int page = 1,
        [FromQuery, Range(1, 100)] int size = 20)
    {
        var filters = new Dictionary<string, object>();
        var result = await service.ListOrdersAsync(ListQuery.Of(filters, null, (page - 1) * size, size));
        return StatusCode(200, new PageResponse<OrderResponse>([.. result.Items.Select(OrderResponse.From)], result.Total, page, size));
    }

    /// <summary>Get an order.</summary>
    [HttpGet("/orders/{id}")]
    public async Task<IActionResult> GetOrder([FromRoute(Name = "id")] long key)
    {
        return StatusCode(200, OrderResponse.From(await service.GetOrderAsync(key)));
    }

    /// <summary>Create an order.</summary>
    [HttpPost("/orders")]
    public async Task<IActionResult> CreateOrder([FromBody] OrderCreate data)
    {
        return StatusCode(201, OrderResponse.From(await service.CreateOrderAsync(data)));
    }

    /// <summary>Replace an order.</summary>
    [HttpPut("/orders/{id}")]
    public async Task<IActionResult> ReplaceOrder(
        [FromRoute(Name = "id")] long key,
        [FromBody] OrderCreate data)
    {
        return StatusCode(200, OrderResponse.From(await service.ReplaceOrderAsync(key, data)));
    }

    /// <summary>Update part of an order.</summary>
    [HttpPatch("/orders/{id}")]
    public async Task<IActionResult> UpdateOrder(
        [FromRoute(Name = "id")] long key,
        [FromBody] OrderUpdate data)
    {
        return StatusCode(200, OrderResponse.From(await service.UpdateOrderAsync(key, data)));
    }

    /// <summary>Delete an order.</summary>
    [HttpDelete("/orders/{id}")]
    public async Task<IActionResult> DeleteOrder([FromRoute(Name = "id")] long key)
    {
        await service.DeleteOrderAsync(key);
        return StatusCode(204);
    }
}
