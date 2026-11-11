// Rules of customers: what each operation checks and changes.

import Foundation

/// Rules of customers.
struct CustomerService: Sendable {
    let repository: any CustomerRepository

    private func find(_ key: Int64) async throws -> Customer {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("customer")
        }
        return item
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Customer, _ body: Body<CustomerCreate>) {
        let data = body.value
        item.name = data.name
        item.email = data.email
        item.password = data.password
        item.phone = data.phone
        item.address = data.address
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Customer, _ body: Body<CustomerUpdate>) {
        let data = body.value
        if body.has("name") {
            item.name = data.name
        }
        if body.has("email") {
            item.email = data.email
        }
        if body.has("password") {
            item.password = data.password
        }
        if body.has("phone") {
            item.phone = data.phone
        }
        if body.has("address") {
            item.address = data.address
        }
    }

    /// List customers.
    func listCustomers(_ query: ListQuery<CustomerFilters>) async throws -> ListResult<Customer> {
        try await repository.list(query)
    }

    /// Get a customer.
    func getCustomer(_ key: Int64) async throws -> Customer {
        try await find(key)
    }

    /// Create a customer.
    func createCustomer(_ body: Body<CustomerCreate>) async throws -> Customer {
        var item = Customer()
        Self.apply(&item, body)
        item.createdAt = ServerClock.now()
        return try await repository.add(item)
    }

    /// Replace a customer: every field the client may send takes the value of the body.
    func replaceCustomer(_ key: Int64, _ body: Body<CustomerCreate>) async throws -> Customer {
        var item = try await find(key)
        Self.apply(&item, body)
        return try await repository.update(item)
    }

    /// Update part of a customer: only the fields in the body change.
    func updateCustomer(_ key: Int64, _ body: Body<CustomerUpdate>) async throws -> Customer {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        return try await repository.update(item)
    }

    /// Delete a customer.
    func deleteCustomer(_ key: Int64) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
