// Rules of orders: what each operation checks and changes.

import Foundation

/// Rules of orders.
struct OrderService: Sendable {
    let repository: any OrderRepository
    let customerRepository: any CustomerRepository
    let productRepository: any ProductRepository

    private func find(_ key: Int64) async throws -> Order {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("order")
        }
        return item
    }

    /// Every reference must point to a stored item.
    private func checkReferences(_ item: Order) async throws {
        if let reference0 = item.customerId, try await customerRepository.get(reference0) == nil {
            throw ApiError.invalid("customerId", "No Customer has this key")
        }
        for item0 in item.lines ?? [] {
            if let reference1 = item0.productId, try await productRepository.get(reference1) == nil {
                throw ApiError.invalid("lines.productId", "No Product has this key")
            }
        }
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Order, _ body: Body<OrderCreate>) {
        let data = body.value
        item.customerId = data.customerId
        item.lines = data.lines
        item.status = data.status
        item.total = data.total
        item.notes = data.notes
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Order, _ body: Body<OrderUpdate>) {
        let data = body.value
        if body.has("customerId") {
            item.customerId = data.customerId
        }
        if body.has("lines") {
            item.lines = data.lines
        }
        if body.has("status") {
            item.status = data.status
        }
        if body.has("total") {
            item.total = data.total
        }
        if body.has("notes") {
            item.notes = data.notes
        }
    }

    /// List orders.
    func listOrders(_ query: ListQuery<OrderFilters>) async throws -> ListResult<Order> {
        try await repository.list(query)
    }

    /// Get an order.
    func getOrder(_ key: Int64) async throws -> Order {
        try await find(key)
    }

    /// Create an order.
    func createOrder(_ body: Body<OrderCreate>) async throws -> Order {
        var item = Order()
        Self.apply(&item, body)
        try await checkReferences(item)
        item.createdAt = ServerClock.now()
        item.updatedAt = ServerClock.now()
        return try await repository.add(item)
    }

    /// Replace an order: every field the client may send takes the value of the body.
    func replaceOrder(_ key: Int64, _ body: Body<OrderCreate>) async throws -> Order {
        var item = try await find(key)
        Self.apply(&item, body)
        try await checkReferences(item)
        item.updatedAt = ServerClock.now()
        return try await repository.update(item)
    }

    /// Update part of an order: only the fields in the body change.
    func updateOrder(_ key: Int64, _ body: Body<OrderUpdate>) async throws -> Order {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        try await checkReferences(item)
        item.updatedAt = ServerClock.now()
        return try await repository.update(item)
    }

    /// Delete an order.
    func deleteOrder(_ key: Int64) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
