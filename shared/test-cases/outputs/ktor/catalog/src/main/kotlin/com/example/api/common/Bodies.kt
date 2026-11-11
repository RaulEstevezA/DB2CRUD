package com.example.api.common

import io.ktor.server.application.ApplicationCall
import io.ktor.server.request.receiveText
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.math.BigDecimal

/** A request body: its values, and the JSON names it carried (a field sent as null is there, a missing one is not). */
class Body<T>(val value: T, private val sent: Set<String>) {
    fun has(field: String): Boolean = field in sent
}

/** The kinds of JSON value a field can hold. */
enum class JsonKind { TEXT, WHOLE, NUMBER, BOOLEAN, LIST, OBJECT }

/** The problems of a request body, by field. Embedded objects add their path: `address.street`. */
class Checks(private val problems: MutableList<ErrorDetail> = mutableListOf(), private val prefix: String = "") {
    val details: List<ErrorDetail> get() = problems

    fun fail(field: String, message: String) {
        problems += ErrorDetail("$prefix$field", message)
    }

    fun required(json: JsonObject, field: String) {
        if (field !in json) fail(field, "The field is required")
    }

    fun notNull(json: JsonObject, field: String) {
        if (json[field] is JsonNull) fail(field, "The field must not be null")
    }

    /** The value has the kind of the field; null is left to notNull. */
    fun kind(json: JsonObject, field: String, kind: JsonKind) {
        val value = json[field] ?: return
        if (value is JsonNull) return
        val primitive = value as? JsonPrimitive
        val number = primitive?.takeUnless { it.isString }?.content?.toBigDecimalOrNull()
        val valid = when (kind) {
            JsonKind.TEXT -> primitive != null && primitive.isString
            JsonKind.WHOLE -> number != null && number.stripTrailingZeros().scale() <= 0
            JsonKind.NUMBER -> number != null
            JsonKind.BOOLEAN -> primitive != null && !primitive.isString && primitive.booleanOrNull != null
            JsonKind.LIST -> value is JsonArray
            JsonKind.OBJECT -> value is JsonObject
        }
        if (!valid) fail(field, "Must be ${kind.name.lowercase()}")
    }

    fun length(json: JsonObject, field: String, min: Int?, max: Int?) {
        val text = text(json[field]) ?: return
        if ((min != null && text.length < min) || (max != null && text.length > max)) fail(field, "Has a length out of its limits")
    }

    fun count(json: JsonObject, field: String, min: Int?, max: Int?) {
        val list = json[field] as? JsonArray ?: return
        if ((min != null && list.size < min) || (max != null && list.size > max)) fail(field, "Has a number of items out of its limits")
    }

    fun range(json: JsonObject, field: String, min: String?, max: String?, minExclusive: Boolean, maxExclusive: Boolean) {
        val primitive = json[field] as? JsonPrimitive ?: return
        if (primitive.isString) return
        val number = primitive.content.toBigDecimalOrNull() ?: return
        val low = min?.let { number.compareTo(BigDecimal(it)) }
        val high = max?.let { number.compareTo(BigDecimal(it)) }
        val below = low != null && (low < 0 || (minExclusive && low == 0))
        val above = high != null && (high > 0 || (maxExclusive && high == 0))
        if (below || above) fail(field, "Is out of its range")
    }

    /** The text matches the expression somewhere, as "pattern" reads it in openapi.yaml. */
    fun pattern(json: JsonObject, field: String, regex: Regex) {
        val text = text(json[field]) ?: return
        if (!regex.containsMatchIn(text)) fail(field, "Has the wrong format")
    }

    fun email(json: JsonObject, field: String) {
        val text = text(json[field]) ?: return
        if (!EMAIL.matches(text)) fail(field, "Must be an email address")
    }

    /** The rules of an embedded object, with its path before each field. */
    fun nested(json: JsonObject, field: String, rules: (Checks, JsonObject) -> Unit) {
        val inner = json[field] as? JsonObject ?: return
        rules(Checks(problems, "$prefix$field."), inner)
    }

    /** The rules of each embedded object of a list. */
    fun each(json: JsonObject, field: String, rules: (Checks, JsonObject) -> Unit) {
        val list = json[field] as? JsonArray ?: return
        list.forEachIndexed { index, item ->
            if (item is JsonObject) rules(Checks(problems, "$prefix$field[$index]."), item)
        }
    }

    private fun text(value: JsonElement?): String? = (value as? JsonPrimitive)?.takeIf { it.isString }?.content

    private companion object {
        val EMAIL = Regex("^[^@\\s]+@[^@\\s]+$")
    }
}

/**
 * Reads a request body: a JSON object that meets its rules (with every problem reported) and has no field the
 * contract does not describe.
 */
suspend fun <T> ApplicationCall.receiveBody(serializer: KSerializer<T>, rules: (Checks, JsonObject) -> Unit): Body<T> {
    val json = try {
        JsonFormat.parseToJsonElement(receiveText())
    } catch (error: SerializationException) {
        throw ApiException(400, "validation_error", "The body is not valid JSON")
    }
    if (json !is JsonObject) throw ApiException(400, "validation_error", "The body must be a JSON object")
    val checks = Checks()
    rules(checks, json)
    if (checks.details.isNotEmpty()) throw ApiException(400, "validation_error", "The request is not valid", checks.details)
    val value = try {
        JsonFormat.decodeFromJsonElement(serializer, json)
    } catch (error: SerializationException) {
        throw ApiException.invalid("", error.message ?: "The body has a value of the wrong type or an unknown field")
    } catch (error: IllegalArgumentException) {
        throw ApiException.invalid("", error.message ?: "The body has a value of the wrong type")
    }
    return Body(value, json.keys)
}
