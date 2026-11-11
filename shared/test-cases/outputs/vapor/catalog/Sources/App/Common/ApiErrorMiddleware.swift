// Every error leaves the API in its error format.

import Vapor

/// Turns every error into the error format of the API, and tells a wrong method from a missing route.
struct ApiErrorMiddleware: AsyncMiddleware {
    func respond(to request: Request, chainingTo next: any AsyncResponder) async throws -> Response {
        do {
            return try await next.respond(to: request)
        } catch let error as ApiError {
            return errorResponse(error)
        } catch let error as any AbortError where error.status == .notFound {
            if acceptsOtherMethod(request) {
                return errorResponse(ApiError(status: .methodNotAllowed, code: "method_not_allowed", message: "This path does not accept this method"))
            }
            return errorResponse(ApiError(status: .notFound, code: "not_found", message: "No route matches this request"))
        } catch let error as any AbortError where error.status.code < 500 {
            return errorResponse(ApiError(status: error.status, code: "bad_request", message: error.reason))
        } catch {
            request.logger.error("Unexpected error: \(String(describing: error))")
            return errorResponse(.serverError())
        }
    }
    /// The error as the API answers it.
    private func errorResponse(_ error: ApiError) -> Response {
        let body = ErrorEnvelope(error: ErrorBody(code: error.code, message: error.message, details: error.details.isEmpty ? nil : error.details))
        return (try? jsonResponse(error.status, body)) ?? Response(status: error.status)
    }

    /// Whether a route takes this path with another method.
    private func acceptsOtherMethod(_ request: Request) -> Bool {
        let parts = request.url.path.split(separator: "/").map(String.init)
        return request.application.routes.all.contains { route in
            route.method != request.method && matches(route.path, parts)
        }
    }

    private func matches(_ path: [PathComponent], _ parts: [String]) -> Bool {
        guard path.count == parts.count else { return false }
        for (component, part) in zip(path, parts) {
            switch component {
            case .constant(let text) where text != part:
                return false
            case .catchall:
                return true
            default:
                continue
            }
        }
        return true
    }
}

private struct ErrorEnvelope: Encodable {
    let error: ErrorBody
}

private struct ErrorBody: Encodable {
    let code: String
    let message: String
    let details: [ErrorDetail]?
}
