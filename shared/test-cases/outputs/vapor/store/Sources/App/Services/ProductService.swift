// Rules of products: what each operation checks and changes.

import Foundation

/// Rules of products.
struct ProductService: Sendable {
    let repository: any ProductRepository

    private func find(_ key: Int64) async throws -> Product {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("product")
        }
        return item
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Product, _ body: Body<ProductCreate>) {
        let data = body.value
        item.sku = data.sku
        item.name = data.name
        item.description = data.description
        item.price = data.price
        item.stock = data.stock
        item.active = data.active
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Product, _ body: Body<ProductUpdate>) {
        let data = body.value
        if body.has("sku") {
            item.sku = data.sku
        }
        if body.has("name") {
            item.name = data.name
        }
        if body.has("description") {
            item.description = data.description
        }
        if body.has("price") {
            item.price = data.price
        }
        if body.has("stock") {
            item.stock = data.stock
        }
        if body.has("active") {
            item.active = data.active
        }
    }

    /// List products.
    func listProducts(_ query: ListQuery<ProductFilters>) async throws -> ListResult<Product> {
        try await repository.list(query)
    }

    /// Get a product.
    func getProduct(_ key: Int64) async throws -> Product {
        try await find(key)
    }

    /// Create a product.
    func createProduct(_ body: Body<ProductCreate>) async throws -> Product {
        var item = Product()
        Self.apply(&item, body)
        return try await repository.add(item)
    }

    /// Replace a product: every field the client may send takes the value of the body.
    func replaceProduct(_ key: Int64, _ body: Body<ProductCreate>) async throws -> Product {
        var item = try await find(key)
        Self.apply(&item, body)
        return try await repository.update(item)
    }

    /// Update part of a product: only the fields in the body change.
    func updateProduct(_ key: Int64, _ body: Body<ProductUpdate>) async throws -> Product {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        return try await repository.update(item)
    }

    /// Delete a product.
    func deleteProduct(_ key: Int64) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
