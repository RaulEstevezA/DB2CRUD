package com.example.api.common

import io.ktor.server.application.ApplicationCall
import java.time.LocalDate
import java.time.OffsetDateTime
import java.util.UUID

/** Keys in paths and values in query strings are text: they are read with their type, and a malformed one is a 400. */
fun ApplicationCall.longKey(name: String): Long =
    parameters[name]?.toLongOrNull() ?: throw ApiException.invalid(name, "Must be a whole number")

fun ApplicationCall.uuidKey(name: String): UUID = parameters[name]?.let(::parseUuid) ?: throw ApiException.invalid(name, "Must be a UUID")

fun ApplicationCall.textKey(name: String): String = parameters[name] ?: throw ApiException.invalid(name, "Is missing")

/** A whole number of the query string within its limits; the default when it is not there. */
fun ApplicationCall.intQuery(name: String, default: Int, min: Int, max: Int? = null): Int {
    val text = request.queryParameters[name] ?: return default
    val value = text.toIntOrNull()
    if (value == null || value < min || (max != null && value > max)) throw ApiException.invalid(name, "Must be a whole number within its limits")
    return value
}

/** A filter of the query string read with its type, or null when it is not there; a malformed one is a 400. */
fun <T : Any> ApplicationCall.filter(name: String, parse: (String) -> T?): T? {
    val text = request.queryParameters[name] ?: return null
    return parse(text) ?: throw ApiException.invalid(name, "Has the wrong format")
}

/** A value of the query string that must be one of the choices. */
fun ApplicationCall.choiceQuery(name: String, choices: List<String>): String? {
    val text = request.queryParameters[name] ?: return null
    if (text !in choices) throw ApiException.invalid(name, "Must be one of: ${choices.joinToString()}")
    return text
}

private val UUID_TEXT = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

fun parseUuid(text: String): UUID? = if (UUID_TEXT.matches(text)) UUID.fromString(text) else null

fun parseDate(text: String): LocalDate? = runCatching { LocalDate.parse(text) }.getOrNull()

fun parseDateTime(text: String): java.time.Instant? = runCatching { OffsetDateTime.parse(text).toInstant() }.getOrNull()
