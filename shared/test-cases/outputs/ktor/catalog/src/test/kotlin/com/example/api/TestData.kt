package com.example.api

import com.example.api.common.Settings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Settings of the application under test. */
fun testSettings() = Settings()

/** Headers of a client allowed to call every endpoint. */
fun headers(): Map<String, String> = emptyMap()

/** A valid body to create a category, with the items it refers to created first. */
suspend fun Api.categoryPayload(variant: Int = 0): JsonObject {
    val body = if (variant == 0) Json.parseToJsonElement("{\"name\":\"name 1\"}") else Json.parseToJsonElement("{\"name\":\"name 2\"}")
    return body.jsonObject
}

/** Creates a category and returns it as the API answers. */
suspend fun Api.createCategory(variant: Int = 0): JsonObject {
    val response = post("/categories", categoryPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}

/** A valid body to create an item, with the items it refers to created first. */
suspend fun Api.itemPayload(variant: Int = 0): JsonObject {
    var body = if (variant == 0) Json.parseToJsonElement("{\"name\":\"name 1\",\"price\":0,\"supplierEmail\":\"user1@example.com\",\"categoryId\":null,\"stock\":0}") else Json.parseToJsonElement("{\"name\":\"name 2\",\"price\":0.5,\"supplierEmail\":\"user2@example.com\",\"categoryId\":null,\"stock\":1}")
    body = body.with(listOf("categoryId"), createCategory().getValue("id"))
    return body.jsonObject
}

/** Creates an item and returns it as the API answers. */
suspend fun Api.createItem(variant: Int = 0): JsonObject {
    val response = post("/items", itemPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}
