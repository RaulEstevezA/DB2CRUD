// Rules of items: what each operation checks and changes.

import Foundation

/// Rules of items.
struct ItemService: Sendable {
    let repository: any ItemRepository
    let categoryRepository: any CategoryRepository

    private func find(_ key: Int64) async throws -> Item {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("item")
        }
        return item
    }

    /// Every reference must point to a stored item.
    private func checkReferences(_ item: Item) async throws {
        if let reference0 = item.categoryId, try await categoryRepository.get(reference0) == nil {
            throw ApiError.invalid("categoryId", "No Category has this key")
        }
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Item, _ body: Body<ItemCreate>) {
        let data = body.value
        item.name = data.name
        item.price = data.price
        item.supplierEmail = data.supplierEmail
        item.categoryId = data.categoryId
        item.stock = data.stock
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Item, _ body: Body<ItemUpdate>) {
        let data = body.value
        if body.has("name") {
            item.name = data.name
        }
        if body.has("price") {
            item.price = data.price
        }
        if body.has("supplierEmail") {
            item.supplierEmail = data.supplierEmail
        }
        if body.has("categoryId") {
            item.categoryId = data.categoryId
        }
        if body.has("stock") {
            item.stock = data.stock
        }
    }

    /// List items.
    func listItems(_ query: ListQuery<ItemFilters>) async throws -> ListResult<Item> {
        try await repository.list(query)
    }

    /// Get an item.
    func getItem(_ key: Int64) async throws -> Item {
        try await find(key)
    }

    /// Create an item.
    func createItem(_ body: Body<ItemCreate>) async throws -> Item {
        var item = Item()
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.add(item)
    }

    /// Replace an item: every field the client may send takes the value of the body.
    func replaceItem(_ key: Int64, _ body: Body<ItemCreate>) async throws -> Item {
        var item = try await find(key)
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Update part of an item: only the fields in the body change.
    func updateItem(_ key: Int64, _ body: Body<ItemUpdate>) async throws -> Item {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Delete an item.
    func deleteItem(_ key: Int64) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
