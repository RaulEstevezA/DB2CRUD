package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the categories endpoints. */
class CategoryApiTest : ApiTest() {
    @Test
    fun `creates a category`() = api {
        val payload = categoryPayload()

        val response = post("/categories", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["name"], body["name"])
    }

    @Test
    fun `rejects a category without name`() = api {
        val payload = categoryPayload().without("name")

        val response = post("/categories", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "name" })
    }

    @Test
    fun `gets a category`() = api {
        val created = createCategory()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/categories/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing category`() = api {
        val response = get("/categories/999999", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists categories`() = api {
        createCategory()
        createCategory(1)

        val response = get("/categories", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists categories by page`() = api {
        createCategory()
        createCategory(1)

        val response = get("/categories?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/categories?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces a category`() = api {
        val created = createCategory()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = categoryPayload(1)

        val response = put("/categories/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["name"], body["name"])
    }

    @Test
    fun `updates part of a category`() = api {
        val created = createCategory()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/categories/" + key, Json.parseToJsonElement("{\"name\":\"name 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("name 2", response.json!!.jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for name`() = api {
        val created = createCategory()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/categories/" + key, Json.parseToJsonElement("{\"name\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes a category`() = api {
        val created = createCategory()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/categories/" + key, headers())

        response.assertStatus(204)
        get("/categories/" + key, headers()).assertStatus(404)
    }
}
