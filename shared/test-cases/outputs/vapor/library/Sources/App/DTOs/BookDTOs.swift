// Request bodies and responses of books.

import Foundation

/// Body of a request that creates or replaces a book.
struct BookCreate: Decodable, Sendable {
    var title: String?
    var isbn: String?
    var authorId: UUID?
    var genre: Genre?
    var pages: Int32?
    var published: String?
    var available: Bool?

    enum CodingKeys: String, CodingKey {
        case title
        case isbn
        case authorId
        case genre
        case pages
        case published
        case available
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["title", "isbn", "authorId", "genre", "pages", "published", "available"])
        checks.required(json, "title")
        checks.notNull(json, "title")
        checks.kind(json, "title", .text)
        checks.length(json, "title", min: 1, max: 200)
        checks.required(json, "isbn")
        checks.notNull(json, "isbn")
        checks.kind(json, "isbn", .text)
        checks.pattern(json, "isbn", "^[0-9]{13}$")
        checks.required(json, "authorId")
        checks.notNull(json, "authorId")
        checks.kind(json, "authorId", .text)
        checks.required(json, "genre")
        checks.notNull(json, "genre")
        checks.kind(json, "genre", .text)
        checks.required(json, "pages")
        checks.notNull(json, "pages")
        checks.kind(json, "pages", .whole)
        checks.range(json, "pages", min: 1, max: 5000, minExclusive: false, maxExclusive: false)
        checks.kind(json, "published", .text)
        checks.pattern(json, "published", "^\\d{4}-\\d{2}-\\d{2}$")
        checks.notNull(json, "available")
        checks.kind(json, "available", .boolean)
    }
}

/// Body of a request that changes part of a book: only the fields sent change.
struct BookUpdate: Decodable, Sendable {
    var title: String?
    var isbn: String?
    var authorId: UUID?
    var genre: Genre?
    var pages: Int32?
    var published: String?
    var available: Bool?

    enum CodingKeys: String, CodingKey {
        case title
        case isbn
        case authorId
        case genre
        case pages
        case published
        case available
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["title", "isbn", "authorId", "genre", "pages", "published", "available"])
        checks.notNull(json, "title")
        checks.kind(json, "title", .text)
        checks.length(json, "title", min: 1, max: 200)
        checks.notNull(json, "isbn")
        checks.kind(json, "isbn", .text)
        checks.pattern(json, "isbn", "^[0-9]{13}$")
        checks.notNull(json, "authorId")
        checks.kind(json, "authorId", .text)
        checks.notNull(json, "genre")
        checks.kind(json, "genre", .text)
        checks.notNull(json, "pages")
        checks.kind(json, "pages", .whole)
        checks.range(json, "pages", min: 1, max: 5000, minExclusive: false, maxExclusive: false)
        checks.kind(json, "published", .text)
        checks.pattern(json, "published", "^\\d{4}-\\d{2}-\\d{2}$")
        checks.notNull(json, "available")
        checks.kind(json, "available", .boolean)
    }
}

/// A book as the API returns it: everything but what clients only send.
struct BookResponse: Encodable, Sendable {
    let item: Book

    init(_ item: Book) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case isbn
        case authorId
        case genre
        case pages
        case published
        case available
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id.uuidString.lowercased(), forKey: .id)
        try container.encode(item.title, forKey: .title)
        try container.encode(item.isbn, forKey: .isbn)
        try container.encode(jsonUUID(item.authorId), forKey: .authorId)
        try container.encode(item.genre, forKey: .genre)
        try container.encode(item.pages, forKey: .pages)
        try container.encode(item.published, forKey: .published)
        try container.encode(item.available, forKey: .available)
    }
}
