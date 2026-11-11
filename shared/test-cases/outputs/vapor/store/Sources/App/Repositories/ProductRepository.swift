// Where products are kept.

import Foundation

/// What a list of products can filter by: a field that has a value must be equal to it.
struct ProductFilters: Sendable {}

/// Where products are kept. The service depends only on this protocol.
protocol ProductRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<ProductFilters>) async throws -> ListResult<Product>

    /// The item with this key, or nil when there is none.
    func get(_ key: Int64) async throws -> Product?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Product) async throws -> Product

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Product) async throws -> Product

    /// Removes an existing item.
    func delete(_ key: Int64) async throws
}

/// Keeps products in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryProductRepository: ProductRepository {
    private var items: [Int64: Product] = [:]
    private var lastKey: Int64 = 0

    func list(_ query: ListQuery<ProductFilters>) async throws -> ListResult<Product> {
        let found = items.values.sorted { $0.id < $1.id }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: Int64) async throws -> Product? {
        items[key]
    }

    func add(_ item: Product) async throws -> Product {
        var item = item
        lastKey += 1
        item.id = lastKey
        items[item.id] = item
        return item
    }

    func update(_ item: Product) async throws -> Product {
        items[item.id] = item
        return item
    }

    func delete(_ key: Int64) async throws {
        items[key] = nil
    }
}
