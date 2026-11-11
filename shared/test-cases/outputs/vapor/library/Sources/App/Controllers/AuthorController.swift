// Routes of authors: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of authors.
struct AuthorController: RouteCollection {
    let service: AuthorService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "authors", use: self.listAuthors)
        routes.on(.GET, "authors", ":id", use: self.getAuthor)
        routes.on(.POST, "authors", use: self.createAuthor)
        routes.on(.PUT, "authors", ":id", use: self.replaceAuthor)
        routes.on(.PATCH, "authors", ":id", use: self.updateAuthor)
        routes.on(.DELETE, "authors", ":id", use: self.deleteAuthor)
    }

    /// List authors.
    @Sendable
    func listAuthors(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = AuthorFilters()
        let result = try await service.listAuthors(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(AuthorResponse.init), total: result.total, page: page, size: size))
    }

    /// Get an author.
    @Sendable
    func getAuthor(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), AuthorResponse(try await service.getAuthor(key)))
    }

    /// Create an author.
    @Sendable
    func createAuthor(req: Request) async throws -> Response {
        let body = try readBody(req, as: AuthorCreate.self, rules: AuthorCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), AuthorResponse(try await service.createAuthor(body)))
    }

    /// Replace an author.
    @Sendable
    func replaceAuthor(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        let body = try readBody(req, as: AuthorCreate.self, rules: AuthorCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), AuthorResponse(try await service.replaceAuthor(key, body)))
    }

    /// Update part of an author.
    @Sendable
    func updateAuthor(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        let body = try readBody(req, as: AuthorUpdate.self, rules: AuthorUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), AuthorResponse(try await service.updateAuthor(key, body)))
    }

    /// Delete an author.
    @Sendable
    func deleteAuthor(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        try await service.deleteAuthor(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
