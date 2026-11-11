// Where books are kept.

import Foundation

/// What a list of books can filter by: a field that has a value must be equal to it.
struct BookFilters: Sendable {}

/// Where books are kept. The service depends only on this protocol.
protocol BookRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<BookFilters>) async throws -> ListResult<Book>

    /// The item with this key, or nil when there is none.
    func get(_ key: UUID) async throws -> Book?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Book) async throws -> Book

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Book) async throws -> Book

    /// Removes an existing item.
    func delete(_ key: UUID) async throws
}

/// Keeps books in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryBookRepository: BookRepository {
    private var items: [UUID: Book] = [:]

    func list(_ query: ListQuery<BookFilters>) async throws -> ListResult<Book> {
        let found = items.values.sorted { $0.id.uuidString < $1.id.uuidString }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: UUID) async throws -> Book? {
        items[key]
    }

    func add(_ item: Book) async throws -> Book {
        var item = item
        item.id = UUID()
        items[item.id] = item
        return item
    }

    func update(_ item: Book) async throws -> Book {
        items[item.id] = item
        return item
    }

    func delete(_ key: UUID) async throws {
        items[key] = nil
    }
}
