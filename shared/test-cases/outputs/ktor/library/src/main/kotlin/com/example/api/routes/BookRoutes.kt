package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.receiveBody
import com.example.api.common.uuidKey
import com.example.api.dto.BookCreate
import com.example.api.dto.BookResponse
import com.example.api.dto.BookUpdate
import com.example.api.service.BookService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of books: HTTP in, service calls, HTTP out. */
fun Route.bookRoutes(service: BookService) {
    // List books
    get("/books") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listBooks(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(BookResponse::from), result.total, page, size))
    }

    // Get a book
    get("/books/{id}") {
        val key = call.uuidKey("id")
        call.respond(HttpStatusCode.fromValue(200), BookResponse.from(service.getBook(key)))
    }

    // Create a book
    post("/books") {
        val body = call.receiveBody(BookCreate.serializer(), BookCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), BookResponse.from(service.createBook(body)))
    }

    // Replace a book
    put("/books/{id}") {
        val key = call.uuidKey("id")
        val body = call.receiveBody(BookCreate.serializer(), BookCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), BookResponse.from(service.replaceBook(key, body)))
    }

    // Update part of a book
    patch("/books/{id}") {
        val key = call.uuidKey("id")
        val body = call.receiveBody(BookUpdate.serializer(), BookUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), BookResponse.from(service.updateBook(key, body)))
    }

    // Delete a book
    delete("/books/{id}") {
        val key = call.uuidKey("id")
        service.deleteBook(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
