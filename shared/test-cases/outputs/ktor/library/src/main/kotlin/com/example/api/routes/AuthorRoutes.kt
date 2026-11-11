package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.receiveBody
import com.example.api.common.uuidKey
import com.example.api.dto.AuthorCreate
import com.example.api.dto.AuthorResponse
import com.example.api.dto.AuthorUpdate
import com.example.api.service.AuthorService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of authors: HTTP in, service calls, HTTP out. */
fun Route.authorRoutes(service: AuthorService) {
    // List authors
    get("/authors") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listAuthors(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(AuthorResponse::from), result.total, page, size))
    }

    // Get an author
    get("/authors/{id}") {
        val key = call.uuidKey("id")
        call.respond(HttpStatusCode.fromValue(200), AuthorResponse.from(service.getAuthor(key)))
    }

    // Create an author
    post("/authors") {
        val body = call.receiveBody(AuthorCreate.serializer(), AuthorCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), AuthorResponse.from(service.createAuthor(body)))
    }

    // Replace an author
    put("/authors/{id}") {
        val key = call.uuidKey("id")
        val body = call.receiveBody(AuthorCreate.serializer(), AuthorCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), AuthorResponse.from(service.replaceAuthor(key, body)))
    }

    // Update part of an author
    patch("/authors/{id}") {
        val key = call.uuidKey("id")
        val body = call.receiveBody(AuthorUpdate.serializer(), AuthorUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), AuthorResponse.from(service.updateAuthor(key, body)))
    }

    // Delete an author
    delete("/authors/{id}") {
        val key = call.uuidKey("id")
        service.deleteAuthor(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
