// Where authors are kept.

import Foundation

/// What a list of authors can filter by: a field that has a value must be equal to it.
struct AuthorFilters: Sendable {}

/// Where authors are kept. The service depends only on this protocol.
protocol AuthorRepository: Sendable {
    /// Items equal to every filter, in order, within the window; and how many match.
    func list(_ query: ListQuery<AuthorFilters>) async throws -> ListResult<Author>

    /// The item with this key, or nil when there is none.
    func get(_ key: UUID) async throws -> Author?

    /// Stores a new item and assigns its key; returns it as stored.
    func add(_ item: Author) async throws -> Author

    /// Stores the new state of an existing item and returns it.
    func update(_ item: Author) async throws -> Author

    /// Removes an existing item.
    func delete(_ key: UUID) async throws
}

/// Keeps authors in memory: they are lost when the application stops. Use it to try the API.
actor InMemoryAuthorRepository: AuthorRepository {
    private var items: [UUID: Author] = [:]

    func list(_ query: ListQuery<AuthorFilters>) async throws -> ListResult<Author> {
        let found = items.values.sorted { $0.id.uuidString < $1.id.uuidString }
        let window = found.dropFirst(query.offset).prefix(query.limit ?? Int.max)
        return ListResult(items: Array(window), total: found.count)
    }

    func get(_ key: UUID) async throws -> Author? {
        items[key]
    }

    func add(_ item: Author) async throws -> Author {
        var item = item
        item.id = UUID()
        items[item.id] = item
        return item
    }

    func update(_ item: Author) async throws -> Author {
        items[item.id] = item
        return item
    }

    func delete(_ key: UUID) async throws {
        items[key] = nil
    }
}
