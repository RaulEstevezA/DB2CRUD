// Routes of items: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of items.
struct ItemController: RouteCollection {
    let service: ItemService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "items", use: self.listItems)
        routes.on(.GET, "items", ":id", use: self.getItem)
        routes.on(.POST, "items", use: self.createItem)
        routes.on(.PUT, "items", ":id", use: self.replaceItem)
        routes.on(.PATCH, "items", ":id", use: self.updateItem)
        routes.on(.DELETE, "items", ":id", use: self.deleteItem)
    }

    /// List items.
    @Sendable
    func listItems(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = ItemFilters()
        let result = try await service.listItems(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(ItemResponse.init), total: result.total, page: page, size: size))
    }

    /// Get an item.
    @Sendable
    func getItem(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), ItemResponse(try await service.getItem(key)))
    }

    /// Create an item.
    @Sendable
    func createItem(req: Request) async throws -> Response {
        let body = try readBody(req, as: ItemCreate.self, rules: ItemCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), ItemResponse(try await service.createItem(body)))
    }

    /// Replace an item.
    @Sendable
    func replaceItem(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: ItemCreate.self, rules: ItemCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), ItemResponse(try await service.replaceItem(key, body)))
    }

    /// Update part of an item.
    @Sendable
    func updateItem(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: ItemUpdate.self, rules: ItemUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), ItemResponse(try await service.updateItem(key, body)))
    }

    /// Delete an item.
    @Sendable
    func deleteItem(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        try await service.deleteItem(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
