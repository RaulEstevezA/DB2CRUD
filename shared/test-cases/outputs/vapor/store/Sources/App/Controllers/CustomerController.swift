// Routes of customers: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of customers.
struct CustomerController: RouteCollection {
    let service: CustomerService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "customers", use: self.listCustomers)
        routes.on(.GET, "customers", ":id", use: self.getCustomer)
        routes.on(.POST, "customers", use: self.createCustomer)
        routes.on(.PUT, "customers", ":id", use: self.replaceCustomer)
        routes.on(.PATCH, "customers", ":id", use: self.updateCustomer)
        routes.on(.DELETE, "customers", ":id", use: self.deleteCustomer)
    }

    /// List customers.
    @Sendable
    func listCustomers(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = CustomerFilters()
        let result = try await service.listCustomers(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(CustomerResponse.init), total: result.total, page: page, size: size))
    }

    /// Get a customer.
    @Sendable
    func getCustomer(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), CustomerResponse(try await service.getCustomer(key)))
    }

    /// Create a customer.
    @Sendable
    func createCustomer(req: Request) async throws -> Response {
        let body = try readBody(req, as: CustomerCreate.self, rules: CustomerCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), CustomerResponse(try await service.createCustomer(body)))
    }

    /// Replace a customer.
    @Sendable
    func replaceCustomer(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: CustomerCreate.self, rules: CustomerCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), CustomerResponse(try await service.replaceCustomer(key, body)))
    }

    /// Update part of a customer.
    @Sendable
    func updateCustomer(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: CustomerUpdate.self, rules: CustomerUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), CustomerResponse(try await service.updateCustomer(key, body)))
    }

    /// Delete a customer.
    @Sendable
    func deleteCustomer(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        try await service.deleteCustomer(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
