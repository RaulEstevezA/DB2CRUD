package com.example.api

import com.example.api.common.Settings
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** Settings of the application under test. */
fun testSettings() = Settings()

/** Headers of a client allowed to call every endpoint. */
fun headers(): Map<String, String> = emptyMap()

/** A valid body to create an author, with the items it refers to created first. */
suspend fun Api.authorPayload(variant: Int = 0): JsonObject {
    val body = if (variant == 0) Json.parseToJsonElement("{\"name\":\"name 1\",\"email\":\"user1@example.com\",\"born\":\"2024-01-15\"}") else Json.parseToJsonElement("{\"name\":\"name 2\",\"email\":\"user2@example.com\",\"born\":\"2024-01-16\"}")
    return body.jsonObject
}

/** Creates an author and returns it as the API answers. */
suspend fun Api.createAuthor(variant: Int = 0): JsonObject {
    val response = post("/authors", authorPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}

/** A valid body to create a book, with the items it refers to created first. */
suspend fun Api.bookPayload(variant: Int = 0): JsonObject {
    var body = if (variant == 0) Json.parseToJsonElement("{\"title\":\"title 1\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"novel\",\"pages\":1,\"published\":\"2024-01-15\",\"available\":true}") else Json.parseToJsonElement("{\"title\":\"title 2\",\"isbn\":\"0000000000000\",\"authorId\":null,\"genre\":\"essay\",\"pages\":2,\"published\":\"2024-01-16\",\"available\":false}")
    body = body.with(listOf("authorId"), createAuthor().getValue("id"))
    return body.jsonObject
}

/** Creates a book and returns it as the API answers. */
suspend fun Api.createBook(variant: Int = 0): JsonObject {
    val response = post("/books", bookPayload(variant), headers())
    response.assertStatus(201)
    return response.json!!.jsonObject
}
