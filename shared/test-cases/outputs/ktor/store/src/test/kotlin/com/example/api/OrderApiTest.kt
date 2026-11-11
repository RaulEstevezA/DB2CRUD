package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the orders endpoints. */
class OrderApiTest : ApiTest() {
    @Test
    fun `creates an order`() = api {
        val payload = orderPayload()

        val response = post("/orders", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["status"], body["status"])
        assertEquals(payload["notes"], body["notes"])
    }

    @Test
    fun `rejects an order without lines`() = api {
        val payload = orderPayload().without("lines")

        val response = post("/orders", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "lines" })
    }

    @Test
    fun `gets an order`() = api {
        val created = createOrder()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/orders/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing order`() = api {
        val response = get("/orders/999999", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists orders`() = api {
        createOrder()
        createOrder(1)

        val response = get("/orders", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists orders by page`() = api {
        createOrder()
        createOrder(1)

        val response = get("/orders?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/orders?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces an order`() = api {
        val created = createOrder()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = orderPayload(1)

        val response = put("/orders/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["status"], body["status"])
        assertEquals(payload["notes"], body["notes"])
    }

    @Test
    fun `updates part of an order`() = api {
        val created = createOrder()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/orders/" + key, Json.parseToJsonElement("{\"total\":2}"), headers())

        response.assertStatus(200)
        assertEquals(2.0, response.json!!.jsonObject["total"]!!.jsonPrimitive.double)
    }

    @Test
    fun `rejects null for total`() = api {
        val created = createOrder()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/orders/" + key, Json.parseToJsonElement("{\"total\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes an order`() = api {
        val created = createOrder()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/orders/" + key, headers())

        response.assertStatus(204)
        get("/orders/" + key, headers()).assertStatus(404)
    }
}
