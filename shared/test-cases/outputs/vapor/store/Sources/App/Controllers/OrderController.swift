// Routes of orders: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of orders.
struct OrderController: RouteCollection {
    let service: OrderService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "orders", use: self.listOrders)
        routes.on(.GET, "orders", ":id", use: self.getOrder)
        routes.on(.POST, "orders", use: self.createOrder)
        routes.on(.PUT, "orders", ":id", use: self.replaceOrder)
        routes.on(.PATCH, "orders", ":id", use: self.updateOrder)
        routes.on(.DELETE, "orders", ":id", use: self.deleteOrder)
    }

    /// List orders.
    @Sendable
    func listOrders(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = OrderFilters()
        let result = try await service.listOrders(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(OrderResponse.init), total: result.total, page: page, size: size))
    }

    /// Get an order.
    @Sendable
    func getOrder(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), OrderResponse(try await service.getOrder(key)))
    }

    /// Create an order.
    @Sendable
    func createOrder(req: Request) async throws -> Response {
        let body = try readBody(req, as: OrderCreate.self, rules: OrderCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), OrderResponse(try await service.createOrder(body)))
    }

    /// Replace an order.
    @Sendable
    func replaceOrder(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: OrderCreate.self, rules: OrderCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), OrderResponse(try await service.replaceOrder(key, body)))
    }

    /// Update part of an order.
    @Sendable
    func updateOrder(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: OrderUpdate.self, rules: OrderUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), OrderResponse(try await service.updateOrder(key, body)))
    }

    /// Delete an order.
    @Sendable
    func deleteOrder(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        try await service.deleteOrder(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
