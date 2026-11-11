package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.longKey
import com.example.api.common.receiveBody
import com.example.api.dto.ItemCreate
import com.example.api.dto.ItemResponse
import com.example.api.dto.ItemUpdate
import com.example.api.service.ItemService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of items: HTTP in, service calls, HTTP out. */
fun Route.itemRoutes(service: ItemService) {
    // List items
    get("/items") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listItems(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(ItemResponse::from), result.total, page, size))
    }

    // Get an item
    get("/items/{id}") {
        val key = call.longKey("id")
        call.respond(HttpStatusCode.fromValue(200), ItemResponse.from(service.getItem(key)))
    }

    // Create an item
    post("/items") {
        val body = call.receiveBody(ItemCreate.serializer(), ItemCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), ItemResponse.from(service.createItem(body)))
    }

    // Replace an item
    put("/items/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(ItemCreate.serializer(), ItemCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), ItemResponse.from(service.replaceItem(key, body)))
    }

    // Update part of an item
    patch("/items/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(ItemUpdate.serializer(), ItemUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), ItemResponse.from(service.updateItem(key, body)))
    }

    // Delete an item
    delete("/items/{id}") {
        val key = call.longKey("id")
        service.deleteItem(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
