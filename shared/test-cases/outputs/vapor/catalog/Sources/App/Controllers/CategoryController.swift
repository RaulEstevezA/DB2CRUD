// Routes of categories: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of categories.
struct CategoryController: RouteCollection {
    let service: CategoryService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "categories", use: self.listCategories)
        routes.on(.GET, "categories", ":id", use: self.getCategory)
        routes.on(.POST, "categories", use: self.createCategory)
        routes.on(.PUT, "categories", ":id", use: self.replaceCategory)
        routes.on(.PATCH, "categories", ":id", use: self.updateCategory)
        routes.on(.DELETE, "categories", ":id", use: self.deleteCategory)
    }

    /// List categories.
    @Sendable
    func listCategories(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = CategoryFilters()
        let result = try await service.listCategories(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(CategoryResponse.init), total: result.total, page: page, size: size))
    }

    /// Get a category.
    @Sendable
    func getCategory(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), CategoryResponse(try await service.getCategory(key)))
    }

    /// Create a category.
    @Sendable
    func createCategory(req: Request) async throws -> Response {
        let body = try readBody(req, as: CategoryCreate.self, rules: CategoryCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), CategoryResponse(try await service.createCategory(body)))
    }

    /// Replace a category.
    @Sendable
    func replaceCategory(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: CategoryCreate.self, rules: CategoryCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), CategoryResponse(try await service.replaceCategory(key, body)))
    }

    /// Update part of a category.
    @Sendable
    func updateCategory(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: CategoryUpdate.self, rules: CategoryUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), CategoryResponse(try await service.updateCategory(key, body)))
    }

    /// Delete a category.
    @Sendable
    func deleteCategory(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        try await service.deleteCategory(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
