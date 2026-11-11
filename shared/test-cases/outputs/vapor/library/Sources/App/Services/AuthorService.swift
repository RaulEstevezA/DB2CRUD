// Rules of authors: what each operation checks and changes.

import Foundation

/// Rules of authors.
struct AuthorService: Sendable {
    let repository: any AuthorRepository

    private func find(_ key: UUID) async throws -> Author {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("author")
        }
        return item
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Author, _ body: Body<AuthorCreate>) {
        let data = body.value
        item.name = data.name
        item.email = body.has("email") ? data.email : nil
        item.born = body.has("born") ? data.born : nil
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Author, _ body: Body<AuthorUpdate>) {
        let data = body.value
        if body.has("name") {
            item.name = data.name
        }
        if body.has("email") {
            item.email = data.email
        }
        if body.has("born") {
            item.born = data.born
        }
    }

    /// List authors.
    func listAuthors(_ query: ListQuery<AuthorFilters>) async throws -> ListResult<Author> {
        try await repository.list(query)
    }

    /// Get an author.
    func getAuthor(_ key: UUID) async throws -> Author {
        try await find(key)
    }

    /// Create an author.
    func createAuthor(_ body: Body<AuthorCreate>) async throws -> Author {
        var item = Author()
        Self.apply(&item, body)
        return try await repository.add(item)
    }

    /// Replace an author: every field the client may send takes the value of the body.
    func replaceAuthor(_ key: UUID, _ body: Body<AuthorCreate>) async throws -> Author {
        var item = try await find(key)
        Self.apply(&item, body)
        return try await repository.update(item)
    }

    /// Update part of an author: only the fields in the body change.
    func updateAuthor(_ key: UUID, _ body: Body<AuthorUpdate>) async throws -> Author {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        return try await repository.update(item)
    }

    /// Delete an author.
    func deleteAuthor(_ key: UUID) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
