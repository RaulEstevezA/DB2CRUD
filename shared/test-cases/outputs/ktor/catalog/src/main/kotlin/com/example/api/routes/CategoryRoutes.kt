package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.longKey
import com.example.api.common.receiveBody
import com.example.api.dto.CategoryCreate
import com.example.api.dto.CategoryResponse
import com.example.api.dto.CategoryUpdate
import com.example.api.service.CategoryService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of categories: HTTP in, service calls, HTTP out. */
fun Route.categoryRoutes(service: CategoryService) {
    // List categories
    get("/categories") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listCategories(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(CategoryResponse::from), result.total, page, size))
    }

    // Get a category
    get("/categories/{id}") {
        val key = call.longKey("id")
        call.respond(HttpStatusCode.fromValue(200), CategoryResponse.from(service.getCategory(key)))
    }

    // Create a category
    post("/categories") {
        val body = call.receiveBody(CategoryCreate.serializer(), CategoryCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), CategoryResponse.from(service.createCategory(body)))
    }

    // Replace a category
    put("/categories/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(CategoryCreate.serializer(), CategoryCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), CategoryResponse.from(service.replaceCategory(key, body)))
    }

    // Update part of a category
    patch("/categories/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(CategoryUpdate.serializer(), CategoryUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), CategoryResponse.from(service.updateCategory(key, body)))
    }

    // Delete a category
    delete("/categories/{id}") {
        val key = call.longKey("id")
        service.deleteCategory(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
