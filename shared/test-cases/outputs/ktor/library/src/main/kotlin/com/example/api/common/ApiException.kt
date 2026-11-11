package com.example.api.common

import kotlinx.serialization.Serializable

/** An error the API answers with a status, a code and a message (see openapi.yaml). */
class ApiException(
    val status: Int,
    val code: String,
    override val message: String,
    val details: List<ErrorDetail> = emptyList(),
) : RuntimeException(message) {
    companion object {
        fun invalid(field: String, message: String) =
            ApiException(400, "validation_error", "The request is not valid", listOf(ErrorDetail(field, message)))

        fun notFound(what: String) = ApiException(404, "not_found", "No $what has this key")

        fun conflict(message: String) = ApiException(409, "conflict", message)
    }
}

/** The body of every error: {"error": {"code", "message", "details"}}. */
@Serializable
data class ErrorResponse(val error: ErrorBody) {
    companion object {
        fun of(code: String, message: String, details: List<ErrorDetail> = emptyList()) =
            ErrorResponse(ErrorBody(code, message, details.ifEmpty { null }))
    }
}

/** What went wrong; the details only when there are some. */
@Serializable
data class ErrorBody(val code: String, val message: String, val details: List<ErrorDetail>? = null)

/** Where the request is wrong and why. */
@Serializable
data class ErrorDetail(val field: String, val message: String)
