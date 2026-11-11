// Routes of products: HTTP in, service calls, HTTP out.

import Vapor

/// The routes of products.
struct ProductController: RouteCollection {
    let service: ProductService

    func boot(routes: any RoutesBuilder) throws {
        routes.on(.GET, "products", use: self.listProducts)
        routes.on(.GET, "products", ":id", use: self.getProduct)
        routes.on(.POST, "products", use: self.createProduct)
        routes.on(.PUT, "products", ":id", use: self.replaceProduct)
        routes.on(.PATCH, "products", ":id", use: self.updateProduct)
        routes.on(.DELETE, "products", ":id", use: self.deleteProduct)
    }

    /// List products.
    @Sendable
    func listProducts(req: Request) async throws -> Response {
        let page = try intQuery(req, "page", default: 1, min: 1, max: nil)
        let size = try intQuery(req, "size", default: 20, min: 1, max: 100)
        let filters = ProductFilters()
        let result = try await service.listProducts(ListQuery(filters: filters, sort: nil, offset: (page - 1) * size, limit: size))
        return try jsonResponse(HTTPStatus(statusCode: 200), PageResponse(items: result.items.map(ProductResponse.init), total: result.total, page: page, size: size))
    }

    /// Get a product.
    @Sendable
    func getProduct(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        return try jsonResponse(HTTPStatus(statusCode: 200), ProductResponse(try await service.getProduct(key)))
    }

    /// Create a product.
    @Sendable
    func createProduct(req: Request) async throws -> Response {
        let body = try readBody(req, as: ProductCreate.self, rules: ProductCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 201), ProductResponse(try await service.createProduct(body)))
    }

    /// Replace a product.
    @Sendable
    func replaceProduct(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: ProductCreate.self, rules: ProductCreate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), ProductResponse(try await service.replaceProduct(key, body)))
    }

    /// Update part of a product.
    @Sendable
    func updateProduct(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        let body = try readBody(req, as: ProductUpdate.self, rules: ProductUpdate.rules)
        return try jsonResponse(HTTPStatus(statusCode: 200), ProductResponse(try await service.updateProduct(key, body)))
    }

    /// Delete a product.
    @Sendable
    func deleteProduct(req: Request) async throws -> Response {
        let key = try intKey(req, "id")
        try await service.deleteProduct(key)
        return Response(status: HTTPStatus(statusCode: 204))
    }
}
