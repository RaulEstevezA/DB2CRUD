package com.example.api

import com.example.api.common.JsonFormat
import com.example.api.common.Settings
import com.example.api.common.installErrors
import com.example.api.repository.InMemoryCustomerRepository
import com.example.api.repository.InMemoryOrderRepository
import com.example.api.repository.InMemoryProductRepository
import com.example.api.routes.customerRoutes
import com.example.api.routes.orderRoutes
import com.example.api.routes.productRoutes
import com.example.api.service.CustomerService
import com.example.api.service.OrderService
import com.example.api.service.ProductService
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.routing.routing

/** Starts the API on PORT (8080 by default) with the settings of the environment. */
fun main() {
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    embeddedServer(Netty, port = port) { module(Settings.fromEnvironment()) }.start(wait = true)
}

/** The API: JSON, errors, authentication, storage and routes. */
fun Application.module(settings: Settings) {
    install(ContentNegotiation) { json(JsonFormat) }
    installErrors()

    // Data kept in memory while the application runs; restarting it (or each test) starts empty
    val customerRepository = InMemoryCustomerRepository()
    val productRepository = InMemoryProductRepository()
    val orderRepository = InMemoryOrderRepository()
    val customerService = CustomerService(customerRepository)
    val productService = ProductService(productRepository)
    val orderService = OrderService(orderRepository, customerRepository, productRepository)

    routing {
        customerRoutes(customerService)
        productRoutes(productService)
        orderRoutes(orderService)
    }
}
