package com.example.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Tests of the customers endpoints. */
class CustomerApiTest : ApiTest() {
    @Test
    fun `creates a customer`() = api {
        val payload = customerPayload()

        val response = post("/customers", payload, headers())

        response.assertStatus(201)
        val body = response.json!!.jsonObject
        assertTrue("id" in body)
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["email"], body["email"])
        assertEquals(payload["phone"], body["phone"])
    }

    @Test
    fun `rejects a customer without name`() = api {
        val payload = customerPayload().without("name")

        val response = post("/customers", payload, headers())

        response.assertStatus(400)
        assertEquals("validation_error", response.at("error.code")?.jsonPrimitive?.content)
        assertTrue(response.at("error.details")!!.jsonArray.any { it.jsonObject["field"]?.jsonPrimitive?.content == "name" })
    }

    @Test
    fun `gets a customer`() = api {
        val created = createCustomer()
        val key = created.getValue("id").jsonPrimitive.content

        val response = get("/customers/" + key, headers())

        response.assertStatus(200)
        assertEquals(created, response.json)
    }

    @Test
    fun `answers 404 for a missing customer`() = api {
        val response = get("/customers/999999", headers())

        response.assertStatus(404)
        assertEquals("not_found", response.at("error.code")?.jsonPrimitive?.content)
    }

    @Test
    fun `lists customers`() = api {
        createCustomer()
        createCustomer(1)

        val response = get("/customers", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `lists customers by page`() = api {
        createCustomer()
        createCustomer(1)

        val response = get("/customers?page=2&size=1", headers())

        response.assertStatus(200)
        assertEquals(2, response.at("total")!!.jsonPrimitive.int)
        assertEquals(1, response.at("items")!!.jsonArray.size)
        assertEquals(2, response.at("page")!!.jsonPrimitive.int)
    }

    @Test
    fun `rejects a page that does not exist`() = api {
        val response = get("/customers?page=0", headers())

        response.assertStatus(400)
    }

    @Test
    fun `replaces a customer`() = api {
        val created = createCustomer()
        val key = created.getValue("id").jsonPrimitive.content
        val payload = customerPayload(1)

        val response = put("/customers/" + key, payload, headers())

        response.assertStatus(200)
        val body = response.json!!.jsonObject
        assertEquals(payload["name"], body["name"])
        assertEquals(payload["email"], body["email"])
        assertEquals(payload["phone"], body["phone"])
    }

    @Test
    fun `updates part of a customer`() = api {
        val created = createCustomer()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/customers/" + key, Json.parseToJsonElement("{\"name\":\"name 2\"}"), headers())

        response.assertStatus(200)
        assertEquals("name 2", response.json!!.jsonObject["name"]!!.jsonPrimitive.content)
    }

    @Test
    fun `rejects null for name`() = api {
        val created = createCustomer()
        val key = created.getValue("id").jsonPrimitive.content

        val response = patch("/customers/" + key, Json.parseToJsonElement("{\"name\":null}"), headers())

        response.assertStatus(400)
    }

    @Test
    fun `deletes a customer`() = api {
        val created = createCustomer()
        val key = created.getValue("id").jsonPrimitive.content

        val response = delete("/customers/" + key, headers())

        response.assertStatus(204)
        get("/customers/" + key, headers()).assertStatus(404)
    }
}
