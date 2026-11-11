package com.example.api

import com.example.api.common.Settings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Settings of the application under test. */
fun testSettings() = Settings()

/** Headers of a client allowed to call every endpoint. */
fun headers(): Map<String, String> = emptyMap()

/** A valid body to create a customer, with the items it refers to created first. */
suspend fun Api.customerPayload(variant: Int = 0): JsonObject {
    val body = if (variant == 0) Json.parseToJsonElement("{\"name\":\"name 1\",\"email\":\"email 1\",\"password\":\"password 1\",\"phone\":\"phone 1\",\"address\":{\"street\":\"street 1\",\"city\":\"city 1\",\"postalCode\":\"postalCode 1\",\"country\":\"country 1\"}}") else Json.parseToJsonElement("{\"name\":\"name 2\",\"email\":\"email 2\",\"password\":\"password 2\",\"phone\":\"phone 2\",\"address\":{\"street\":\"street 2\",\"city\":\"city 2\",\"postalCode\":\"postalCode 2\",\"country\":\"country 2\"}}")
    return body.jsonObject
}

/** Creates a customer and returns it as the API answers. */
suspend fun Api.createCustomer(variant: Int = 0): JsonObject {
    val response = post("/customers", customerPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}

/** A valid body to create a product, with the items it refers to created first. */
suspend fun Api.productPayload(variant: Int = 0): JsonObject {
    val body = if (variant == 0) Json.parseToJsonElement("{\"sku\":\"sku 1\",\"name\":\"name 1\",\"description\":\"description 1\",\"price\":1.5,\"stock\":1.5,\"active\":true}") else Json.parseToJsonElement("{\"sku\":\"sku 2\",\"name\":\"name 2\",\"description\":\"description 2\",\"price\":2,\"stock\":2,\"active\":false}")
    return body.jsonObject
}

/** Creates a product and returns it as the API answers. */
suspend fun Api.createProduct(variant: Int = 0): JsonObject {
    val response = post("/products", productPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}

/** A valid body to create an order, with the items it refers to created first. */
suspend fun Api.orderPayload(variant: Int = 0): JsonObject {
    var body = if (variant == 0) Json.parseToJsonElement("{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":1.5,\"unitPrice\":1.5}],\"status\":\"pending\",\"total\":1.5,\"notes\":\"notes 1\"}") else Json.parseToJsonElement("{\"customerId\":null,\"lines\":[{\"productId\":null,\"quantity\":2,\"unitPrice\":2}],\"status\":\"paid\",\"total\":2,\"notes\":\"notes 2\"}")
    body = body.with(listOf("customerId"), createCustomer().getValue("id"))
    body = body.with(listOf("lines", 0, "productId"), createProduct().getValue("id"))
    return body.jsonObject
}

/** Creates an order and returns it as the API answers. */
suspend fun Api.createOrder(variant: Int = 0): JsonObject {
    val response = post("/orders", orderPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}
