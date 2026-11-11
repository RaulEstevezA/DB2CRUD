// The error format of the API: {"error": {"code", "message", "details"}}, with the status of openapi.yaml.

import Vapor

/// Where the request is wrong and why.
struct ErrorDetail: Codable, Sendable {
    let field: String
    let message: String
}

/// An error the API answers with a status, a code and a message (see openapi.yaml).
struct ApiError: Error, Sendable {
    let status: HTTPStatus
    let code: String
    let message: String
    var details: [ErrorDetail] = []

    /// A request that breaks its rules, with each problem.
    static func invalidBody(_ details: [ErrorDetail]) -> ApiError {
        ApiError(status: .badRequest, code: "validation_error", message: "The request is not valid", details: details)
    }

    static func invalid(_ field: String, _ message: String) -> ApiError {
        invalidBody([ErrorDetail(field: field, message: message)])
    }

    static func notFound(_ what: String) -> ApiError {
        ApiError(status: .notFound, code: "not_found", message: "No \(what) has this key")
    }

    static func conflict(_ message: String) -> ApiError {
        ApiError(status: .conflict, code: "conflict", message: message)
    }

    static func unauthorized() -> ApiError {
        ApiError(status: .unauthorized, code: "unauthorized", message: "Missing or invalid credentials")
    }

    static func forbidden() -> ApiError {
        ApiError(status: .forbidden, code: "forbidden", message: "The credentials do not allow this operation")
    }

    /// Code still to write: the API answers 501.
    static func notImplemented(_ message: String) -> ApiError {
        ApiError(status: .notImplemented, code: "not_implemented", message: message)
    }

    static func serverError() -> ApiError {
        ApiError(status: .internalServerError, code: "internal_error", message: "Something went wrong on the server")
    }
}
