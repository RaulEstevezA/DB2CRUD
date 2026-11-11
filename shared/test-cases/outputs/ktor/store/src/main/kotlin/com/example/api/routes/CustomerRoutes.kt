package com.example.api.routes

import com.example.api.common.ListQuery
import com.example.api.common.PageResponse
import com.example.api.common.intQuery
import com.example.api.common.longKey
import com.example.api.common.receiveBody
import com.example.api.dto.CustomerCreate
import com.example.api.dto.CustomerResponse
import com.example.api.dto.CustomerUpdate
import com.example.api.service.CustomerService
import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.put

/** Routes of customers: HTTP in, service calls, HTTP out. */
fun Route.customerRoutes(service: CustomerService) {
    // List customers
    get("/customers") {
        val page = call.intQuery("page", 1, 1)
        val size = call.intQuery("size", 20, 1, 100)
        val filters = emptyMap<String, Any>()
        val result = service.listCustomers(ListQuery.of(filters, null, (page - 1) * size, size))
        call.respond(HttpStatusCode.fromValue(200), PageResponse(result.items.map(CustomerResponse::from), result.total, page, size))
    }

    // Get a customer
    get("/customers/{id}") {
        val key = call.longKey("id")
        call.respond(HttpStatusCode.fromValue(200), CustomerResponse.from(service.getCustomer(key)))
    }

    // Create a customer
    post("/customers") {
        val body = call.receiveBody(CustomerCreate.serializer(), CustomerCreate::rules)
        call.respond(HttpStatusCode.fromValue(201), CustomerResponse.from(service.createCustomer(body)))
    }

    // Replace a customer
    put("/customers/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(CustomerCreate.serializer(), CustomerCreate::rules)
        call.respond(HttpStatusCode.fromValue(200), CustomerResponse.from(service.replaceCustomer(key, body)))
    }

    // Update part of a customer
    patch("/customers/{id}") {
        val key = call.longKey("id")
        val body = call.receiveBody(CustomerUpdate.serializer(), CustomerUpdate::rules)
        call.respond(HttpStatusCode.fromValue(200), CustomerResponse.from(service.updateCustomer(key, body)))
    }

    // Delete a customer
    delete("/customers/{id}") {
        val key = call.longKey("id")
        service.deleteCustomer(key)
        call.respond(HttpStatusCode.fromValue(204))
    }
}
