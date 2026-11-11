// Where items are kept.

import Foundation

/// What a list of items can filter by: a field that has a value must be equal to it.
struct ItemFilters: Sendable {}

/// Where items are kept. The service depends only on this protocol.
protocol ItemRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<ItemFilters>) async throws -> ListResult<Item>

    /// The item with this key, or nil when there is none.
    func get(_ key: Int64) async throws -> Item?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Item) async throws -> Item

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Item) async throws -> Item

    /// Removes an existing item.
    func delete(_ key: Int64) async throws
}

/// Keeps items in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryItemRepository: ItemRepository {
    private var items: [Int64: Item] = [:]
    private var lastKey: Int64 = 0

    func list(_ query: ListQuery<ItemFilters>) async throws -> ListResult<Item> {
        let found = items.values.sorted { $0.id < $1.id }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: Int64) async throws -> Item? {
        items[key]
    }

    func add(_ item: Item) async throws -> Item {
        var item = item
        lastKey += 1
        item.id = lastKey
        items[item.id] = item
        return item
    }

    func update(_ item: Item) async throws -> Item {
        items[item.id] = item
        return item
    }

    func delete(_ key: Int64) async throws {
        items[key] = nil
    }
}
