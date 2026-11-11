// Routes of books: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of books.
struct BookController: RouteCollection {
    let service: BookService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "books", use: self.listBooks)
        routes.on(.GET, "books", ":id", use: self.getBook)
        routes.on(.POST, "books", use: self.createBook)
        routes.on(.PUT, "books", ":id", use: self.replaceBook)
        routes.on(.PATCH, "books", ":id", use: self.updateBook)
        routes.on(.DELETE, "books", ":id", use: self.deleteBook)
    }

    /// List books.
    @Sendable
    func listBooks(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = BookFilters()
        let result = try await service.listBooks(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(BookResponse.init), total: result.total, page: page, size: size))
    }

    /// Get a book.
    @Sendable
    func getBook(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), BookResponse(try await service.getBook(key)))
    }

    /// Create a book.
    @Sendable
    func createBook(req: Request) async throws -> Response {
        let body = try readBody(req, as: BookCreate.self, rules: BookCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), BookResponse(try await service.createBook(body)))
    }

    /// Replace a book.
    @Sendable
    func replaceBook(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        let body = try readBody(req, as: BookCreate.self, rules: BookCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), BookResponse(try await service.replaceBook(key, body)))
    }

    /// Update part of a book.
    @Sendable
    func updateBook(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        let body = try readBody(req, as: BookUpdate.self, rules: BookUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), BookResponse(try await service.updateBook(key, body)))
    }

    /// Delete a book.
    @Sendable
    func deleteBook(req: Request) async throws -> Response {
        let key = try uuidKey(req, "id")
        try await service.deleteBook(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
