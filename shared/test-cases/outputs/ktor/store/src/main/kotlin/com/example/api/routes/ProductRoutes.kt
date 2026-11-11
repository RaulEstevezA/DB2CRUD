package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.longKey
import com.example.api.common.receiveBody
import com.example.api.dto.ProductCreate
import com.example.api.dto.ProductResponse
import com.example.api.dto.ProductUpdate
import com.example.api.service.ProductService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of products: HTTP in, service calls, HTTP out. */
fun Route.productRoutes(service: ProductService) {
    // List products
    get("/products") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listProducts(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(ProductResponse::from), result.total, page, size))
    }

    // Get a product
    get("/products/{id}") {
        val key = call.longKey("id")
        call.respond(HttpStatusCode.fromValue(200), ProductResponse.from(service.getProduct(key)))
    }

    // Create a product
    post("/products") {
        val body = call.receiveBody(ProductCreate.serializer(), ProductCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), ProductResponse.from(service.createProduct(body)))
    }

    // Replace a product
    put("/products/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(ProductCreate.serializer(), ProductCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), ProductResponse.from(service.replaceProduct(key, body)))
    }

    // Update part of a product
    patch("/products/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(ProductUpdate.serializer(), ProductUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), ProductResponse.from(service.updateProduct(key, body)))
    }

    // Delete a product
    delete("/products/{id}") {
        val key = call.longKey("id")
        service.deleteProduct(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
