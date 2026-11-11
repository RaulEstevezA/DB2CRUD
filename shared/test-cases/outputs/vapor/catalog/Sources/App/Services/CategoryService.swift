// Rules of categories: what each operation checks and changes.

import Foundation

/// Rules of categories.
struct CategoryService: Sendable {
    let repository: any CategoryRepository

    private func find(_ key: Int64) async throws -> Category {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("category")
        }
        return item
    }

    /// Every reference must point to a stored item.
    private func checkReferences(_ item: Category) async throws {
        if let reference0 = item.parentId, try await repository.get(reference0) == nil {
            throw ApiError.invalid("parentId", "No Category has this key")
        }
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Category, _ body: Body<CategoryCreate>) {
        let data = body.value
        item.name = data.name
        item.parentId = data.parentId
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Category, _ body: Body<CategoryUpdate>) {
        let data = body.value
        if body.has("name") {
            item.name = data.name
        }
        if body.has("parentId") {
            item.parentId = data.parentId
        }
    }

    /// List categories.
    func listCategories(_ query: ListQuery<CategoryFilters>) async throws -> ListResult<Category> {
        try await repository.list(query)
    }

    /// Get a category.
    func getCategory(_ key: Int64) async throws -> Category {
        try await find(key)
    }

    /// Create a category.
    func createCategory(_ body: Body<CategoryCreate>) async throws -> Category {
        var item = Category()
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.add(item)
    }

    /// Replace a category: every field the client may send takes the value of the body.
    func replaceCategory(_ key: Int64, _ body: Body<CategoryCreate>) async throws -> Category {
        var item = try await find(key)
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Update part of a category: only the fields in the body change.
    func updateCategory(_ key: Int64, _ body: Body<CategoryUpdate>) async throws -> Category {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Delete a category.
    func deleteCategory(_ key: Int64) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
