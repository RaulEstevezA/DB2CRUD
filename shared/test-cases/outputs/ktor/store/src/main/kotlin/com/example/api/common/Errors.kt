package com.example.api.common

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond

/** Answers with an error body and its status. */
suspend fun ApplicationCall.respondError(status: Int, code: String, message: String, details: List<ErrorDetail> = emptyList()) {
    respond(HttpStatusCode.fromValue(status), ErrorResponse.of(code, message, details))
}

/** Answers every error with the format of openapi.yaml. */
fun Application.installErrors() {
    install(StatusPages) {
        exception<ApiException> { call, error -> call.respondError(error.status, error.code, error.message, error.details) }
        exception<NotImplementedError> { call, error ->
            call.respondError(501, "not_implemented", error.message ?: "The logic of this operation is not written yet")
        }
        exception<BadRequestException> { call, _ -> call.respondError(400, "validation_error", "The request is not valid") }
        exception<Throwable> { call, error ->
            call.application.log.error("Unexpected error", error)
            call.respondError(500, "internal_error", "Something went wrong on the server")
        }
        status(HttpStatusCode.NotFound) { call, _ -> call.respondError(404, "not_found", "No route matches this request") }
        status(HttpStatusCode.MethodNotAllowed) { call, _ ->
            call.respondError(405, "method_not_allowed", "This path does not accept this method")
        }
    }
}
