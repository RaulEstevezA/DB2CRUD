// Where orders are kept.

import Foundation

/// What a list of orders can filter by: a field that has a value must be equal to it.
struct OrderFilters: Sendable {}

/// Where orders are kept. The service depends only on this protocol.
protocol OrderRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<OrderFilters>) async throws -> ListResult<Order>

    /// The item with this key, or nil when there is none.
    func get(_ key: Int64) async throws -> Order?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Order) async throws -> Order

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Order) async throws -> Order

    /// Removes an existing item.
    func delete(_ key: Int64) async throws
}

/// Keeps orders in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryOrderRepository: OrderRepository {
    private var items: [Int64: Order] = [:]
    private var lastKey: Int64 = 0

    func list(_ query: ListQuery<OrderFilters>) async throws -> ListResult<Order> {
        let found = items.values.sorted { $0.id < $1.id }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: Int64) async throws -> Order? {
        items[key]
    }

    func add(_ item: Order) async throws -> Order {
        var item = item
        lastKey += 1
        item.id = lastKey
        items[item.id] = item
        return item
    }

    func update(_ item: Order) async throws -> Order {
        items[item.id] = item
        return item
    }

    func delete(_ key: Int64) async throws {
        items[key] = nil
    }
}
