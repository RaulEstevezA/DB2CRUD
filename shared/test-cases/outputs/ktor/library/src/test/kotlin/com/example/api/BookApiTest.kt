package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the books endpoints. */
class BookApiTest : ApiTest() {
    @Test
    fun `creates a book`() = api {
        val payload = bookPayload()

        val response = post("/books", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["title"], body["title"])
        assertEquals(payload["isbn"], body["isbn"])
        assertEquals(payload["genre"], body["genre"])
        assertEquals(payload["pages"], body["pages"])
        assertEquals(payload["available"], body["available"])
    }

    @Test
    fun `rejects a book without title`() = api {
        val payload = bookPayload().without("title")

        val response = post("/books", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "title" })
    }

    @Test
    fun `gets a book`() = api {
        val created = createBook()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/books/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing book`() = api {
        val response = get("/books/00000000-0000-0000-0000-000000000000", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists books`() = api {
        createBook()
        createBook(1)

        val response = get("/books", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists books by page`() = api {
        createBook()
        createBook(1)

        val response = get("/books?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/books?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces a book`() = api {
        val created = createBook()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = bookPayload(1)

        val response = put("/books/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["title"], body["title"])
        assertEquals(payload["isbn"], body["isbn"])
        assertEquals(payload["genre"], body["genre"])
        assertEquals(payload["pages"], body["pages"])
        assertEquals(payload["available"], body["available"])
    }

    @Test
    fun `updates part of a book`() = api {
        val created = createBook()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/books/" + key, Json.parseToJsonElement("{\"title\":\"title 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("title 2", response.json!!.jsonObject["title"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for title`() = api {
        val created = createBook()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/books/" + key, Json.parseToJsonElement("{\"title\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes a book`() = api {
        val created = createBook()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/books/" + key, headers())

        response.assertStatus(204)
        get("/books/" + key, headers()).assertStatus(404)
    }
}
