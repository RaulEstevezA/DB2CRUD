// Where categories are kept.

import Foundation

/// What a list of categories can filter by: a field that has a value must be equal to it.
struct CategoryFilters: Sendable {}

/// Where categories are kept. The service depends only on this protocol.
protocol CategoryRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<CategoryFilters>) async throws -> ListResult<Category>

    /// The item with this key, or nil when there is none.
    func get(_ key: Int64) async throws -> Category?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Category) async throws -> Category

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Category) async throws -> Category

    /// Removes an existing item.
    func delete(_ key: Int64) async throws
}

/// Keeps categories in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryCategoryRepository: CategoryRepository {
    private var items: [Int64: Category] = [:]
    private var lastKey: Int64 = 0

    func list(_ query: ListQuery<CategoryFilters>) async throws -> ListResult<Category> {
        let found = items.values.sorted { $0.id < $1.id }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: Int64) async throws -> Category? {
        items[key]
    }

    func add(_ item: Category) async throws -> Category {
        var item = item
        lastKey += 1
        item.id = lastKey
        items[item.id] = item
        return item
    }

    func update(_ item: Category) async throws -> Category {
        items[item.id] = item
        return item
    }

    func delete(_ key: Int64) async throws {
        items[key] = nil
    }
}
