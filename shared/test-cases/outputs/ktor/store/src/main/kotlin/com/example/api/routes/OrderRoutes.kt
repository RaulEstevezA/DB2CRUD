package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.longKey
import com.example.api.common.receiveBody
import com.example.api.dto.OrderCreate
import com.example.api.dto.OrderResponse
import com.example.api.dto.OrderUpdate
import com.example.api.service.OrderService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of orders: HTTP in, service calls, HTTP out. */
fun Route.orderRoutes(service: OrderService) {
    // List orders
    get("/orders") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listOrders(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(OrderResponse::from), result.total, page, size))
    }

    // Get an order
    get("/orders/{id}") {
        val key = call.longKey("id")
        call.respond(HttpStatusCode.fromValue(200), OrderResponse.from(service.getOrder(key)))
    }

    // Create an order
    post("/orders") {
        val body = call.receiveBody(OrderCreate.serializer(), OrderCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), OrderResponse.from(service.createOrder(body)))
    }

    // Replace an order
    put("/orders/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(OrderCreate.serializer(), OrderCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), OrderResponse.from(service.replaceOrder(key, body)))
    }

    // Update part of an order
    patch("/orders/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(OrderUpdate.serializer(), OrderUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), OrderResponse.from(service.updateOrder(key, body)))
    }

    // Delete an order
    delete("/orders/{id}") {
        val key = call.longKey("id")
        service.deleteOrder(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
