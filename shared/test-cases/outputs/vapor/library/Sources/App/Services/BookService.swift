// Rules of books: what each operation checks and changes.

import Foundation

/// Rules of books.
struct BookService: Sendable {
    let repository: any BookRepository
    let authorRepository: any AuthorRepository

    private func find(_ key: UUID) async throws -> Book {
        guard let item = try await repository.get(key) else {
            throw ApiError.notFound("book")
        }
        return item
    }

    /// Every reference must point to a stored item.
    private func checkReferences(_ item: Book) async throws {
        if let reference0 = item.authorId, try await authorRepository.get(reference0) == nil {
            throw ApiError.invalid("authorId", "No Author has this key")
        }
    }

    /// Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent.
    private static func apply(_ item: inout Book, _ body: Body<BookCreate>) {
        let data = body.value
        item.title = data.title
        item.isbn = data.isbn
        item.authorId = data.authorId
        item.genre = data.genre
        item.pages = data.pages
        item.published = body.has("published") ? data.published : nil
        item.available = body.has("available") ? data.available : true
    }

    /// Sets the fields a partial change carries; the others stay as they are.
    private static func applyChanges(_ item: inout Book, _ body: Body<BookUpdate>) {
        let data = body.value
        if body.has("title") {
            item.title = data.title
        }
        if body.has("isbn") {
            item.isbn = data.isbn
        }
        if body.has("authorId") {
            item.authorId = data.authorId
        }
        if body.has("genre") {
            item.genre = data.genre
        }
        if body.has("pages") {
            item.pages = data.pages
        }
        if body.has("published") {
            item.published = data.published
        }
        if body.has("available") {
            item.available = data.available
        }
    }

    /// List books.
    func listBooks(_ query: ListQuery<BookFilters>) async throws -> ListResult<Book> {
        try await repository.list(query)
    }

    /// Get a book.
    func getBook(_ key: UUID) async throws -> Book {
        try await find(key)
    }

    /// Create a book.
    func createBook(_ body: Body<BookCreate>) async throws -> Book {
        var item = Book()
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.add(item)
    }

    /// Replace a book: every field the client may send takes the value of the body.
    func replaceBook(_ key: UUID, _ body: Body<BookCreate>) async throws -> Book {
        var item = try await find(key)
        Self.apply(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Update part of a book: only the fields in the body change.
    func updateBook(_ key: UUID, _ body: Body<BookUpdate>) async throws -> Book {
        var item = try await find(key)
        Self.applyChanges(&item, body)
        try await checkReferences(item)
        return try await repository.update(item)
    }

    /// Delete a book.
    func deleteBook(_ key: UUID) async throws {
        _ = try await find(key)
        try await repository.delete(key)
    }
}
