// Where customers are kept.

import Foundation

/// What a list of customers can filter by: a field that has a value must be equal to it.
struct CustomerFilters: Sendable {}

/// Where customers are kept. The service depends only on this protocol.
protocol CustomerRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<CustomerFilters>) async throws -> ListResult<Customer>

    /// The item with this key, or nil when there is none.
    func get(_ key: Int64) async throws -> Customer?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Customer) async throws -> Customer

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Customer) async throws -> Customer

    /// Removes an existing item.
    func delete(_ key: Int64) async throws
}

/// Keeps customers in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryCustomerRepository: CustomerRepository {
    private var items: [Int64: Customer] = [:]
    private var lastKey: Int64 = 0

    func list(_ query: ListQuery<CustomerFilters>) async throws -> ListResult<Customer> {
        let found = items.values.sorted { $0.id < $1.id }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: Int64) async throws -> Customer? {
        items[key]
    }

    func add(_ item: Customer) async throws -> Customer {
        var item = item
        lastKey += 1
        item.id = lastKey
        items[item.id] = item
        return item
    }

    func update(_ item: Customer) async throws -> Customer {
        items[item.id] = item
        return item
    }

    func delete(_ key: Int64) async throws {
        items[key] = nil
    }
}
