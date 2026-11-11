package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the authors endpoints. */
class AuthorApiTest : ApiTest() {
    @Test
    fun `creates an author`() = api {
        val payload = authorPayload()

        val response = post("/authors", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["name"], body["name"])
    }

    @Test
    fun `rejects an author without name`() = api {
        val payload = authorPayload().without("name")

        val response = post("/authors", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "name" })
    }

    @Test
    fun `gets an author`() = api {
        val created = createAuthor()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/authors/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing author`() = api {
        val response = get("/authors/00000000-0000-0000-0000-000000000000", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists authors`() = api {
        createAuthor()
        createAuthor(1)

        val response = get("/authors", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists authors by page`() = api {
        createAuthor()
        createAuthor(1)

        val response = get("/authors?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/authors?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces an author`() = api {
        val created = createAuthor()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = authorPayload(1)

        val response = put("/authors/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["name"], body["name"])
    }

    @Test
    fun `updates part of an author`() = api {
        val created = createAuthor()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/authors/" + key, Json.parseToJsonElement("{\"name\":\"name 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("name 2", response.json!!.jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for name`() = api {
        val created = createAuthor()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/authors/" + key, Json.parseToJsonElement("{\"name\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes an author`() = api {
        val created = createAuthor()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/authors/" + key, headers())

        response.assertStatus(204)
        get("/authors/" + key, headers()).assertStatus(404)
    }
}
