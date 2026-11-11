package com.example.api

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.contentType
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlin.test.assertEquals

/** Base of the tests: a new application for each test, so each one starts with empty storage. */
abstract class ApiTest {
    protected fun api(test: suspend Api.() -> Unit) = testApplication {
        application { module(testSettings()) }
        Api(client).test()
    }
}

/** Calls the application under test with JSON. */
class Api(private val client: HttpClient) {
    suspend fun get(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Get, path, null, headers)

    suspend fun post(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =
        send(HttpMethod.Post, path, body, headers)

    suspend fun put(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =
        send(HttpMethod.Put, path, body, headers)

    suspend fun patch(path: String, body: JsonElement?, headers: Map<String, String> = emptyMap()) =
        send(HttpMethod.Patch, path, body, headers)

    suspend fun delete(path: String, headers: Map<String, String> = emptyMap()) = send(HttpMethod.Delete, path, null, headers)

    /** Sends a request, with a JSON body when there is one. */
    suspend fun send(method: HttpMethod, path: String, body: JsonElement?, headers: Map<String, String>): TestResponse {
        val response = client.request(path) {
            this.method = method
            for ((name, value) in headers) header(name, value)
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body.toString())
            }
        }
        return TestResponse(response.status.value, response.bodyAsText())
    }
}

/** The answer of a request in a test: its status, and its JSON body or a value inside it ("error.code"). */
class TestResponse(val status: Int, private val text: String) {
    val json: JsonElement? = if (text.isEmpty()) null else Json.parseToJsonElement(text)

    fun assertStatus(expected: Int) = assertEquals(expected, status, text)

    fun at(path: String): JsonElement? = path.split(".").fold(json) { node, part -> (node as? JsonObject)?.get(part) }
}

/** A copy of a JSON value with another value at a path: listOf("lines", 0, "productId"). */
fun JsonElement.with(path: List<Any>, value: JsonElement): JsonElement {
    if (path.isEmpty()) return value
    val rest = path.drop(1)
    return when (val step = path.first()) {
        is String -> JsonObject(jsonObject + (step to (jsonObject[step] ?: JsonObject(emptyMap())).with(rest, value)))
        else -> JsonArray(jsonArray.mapIndexed { index, item -> if (index == step) item.with(rest, value) else item })
    }
}

/** A copy of a JSON object without a field. */
fun JsonObject.without(field: String) = JsonObject(this - field)
