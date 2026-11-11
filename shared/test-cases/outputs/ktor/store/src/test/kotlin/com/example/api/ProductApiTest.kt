package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the products endpoints. */
class ProductApiTest : ApiTest() {
    @Test
    fun `creates a product`() = api {
        val payload = productPayload()

        val response = post("/products", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["sku"], body["sku"])
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["description"], body["description"])
        assertEquals(payload["active"], body["active"])
    }

    @Test
    fun `rejects a product without sku`() = api {
        val payload = productPayload().without("sku")

        val response = post("/products", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "sku" })
    }

    @Test
    fun `gets a product`() = api {
        val created = createProduct()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/products/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing product`() = api {
        val response = get("/products/999999", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists products`() = api {
        createProduct()
        createProduct(1)

        val response = get("/products", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists products by page`() = api {
        createProduct()
        createProduct(1)

        val response = get("/products?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/products?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces a product`() = api {
        val created = createProduct()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = productPayload(1)

        val response = put("/products/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["sku"], body["sku"])
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["description"], body["description"])
        assertEquals(payload["active"], body["active"])
    }

    @Test
    fun `updates part of a product`() = api {
        val created = createProduct()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/products/" + key, Json.parseToJsonElement("{\"sku\":\"sku 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("sku 2", response.json!!.jsonObject["sku"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for sku`() = api {
        val created = createProduct()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/products/" + key, Json.parseToJsonElement("{\"sku\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes a product`() = api {
        val created = createProduct()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/products/" + key, headers())

        response.assertStatus(204)
        get("/products/" + key, headers()).assertStatus(404)
    }
}
