package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the items endpoints. */
class ItemApiTest : ApiTest() {
    @Test
    fun `creates an item`() = api {
        val payload = itemPayload()

        val response = post("/items", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["stock"], body["stock"])
    }

    @Test
    fun `rejects an item without name`() = api {
        val payload = itemPayload().without("name")

        val response = post("/items", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "name" })
    }

    @Test
    fun `gets an item`() = api {
        val created = createItem()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/items/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing item`() = api {
        val response = get("/items/999999", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists items`() = api {
        createItem()
        createItem(1)

        val response = get("/items", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists items by page`() = api {
        createItem()
        createItem(1)

        val response = get("/items?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/items?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces an item`() = api {
        val created = createItem()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = itemPayload(1)

        val response = put("/items/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["stock"], body["stock"])
    }

    @Test
    fun `updates part of an item`() = api {
        val created = createItem()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/items/" + key, Json.parseToJsonElement("{\"name\":\"name 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("name 2", response.json!!.jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for name`() = api {
        val created = createItem()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/items/" + key, Json.parseToJsonElement("{\"name\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes an item`() = api {
        val created = createItem()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/items/" + key, headers())

        response.assertStatus(204)
        get("/items/" + key, headers()).assertStatus(404)
    }
}
