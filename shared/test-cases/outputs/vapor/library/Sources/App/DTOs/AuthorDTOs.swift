// Request bodies and responses of authors.

import Foundation

/// Body of a request that creates or replaces an author.
struct AuthorCreate: Decodable, Sendable {
    var name: String?
    var email: String?
    var born: String?

    enum CodingKeys: String, CodingKey {
        case name
        case email
        case born
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "email", "born"])
        checks.required(json, "name")
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 2, max: 120)
        checks.kind(json, "email", .text)
        checks.email(json, "email")
        checks.kind(json, "born", .text)
        checks.pattern(json, "born", "^\\d{4}-\\d{2}-\\d{2}$")
    }
}

/// Body of a request that changes part of an author: only the fields sent change.
struct AuthorUpdate: Decodable, Sendable {
    var name: String?
    var email: String?
    var born: String?

    enum CodingKeys: String, CodingKey {
        case name
        case email
        case born
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "email", "born"])
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 2, max: 120)
        checks.kind(json, "email", .text)
        checks.email(json, "email")
        checks.kind(json, "born", .text)
        checks.pattern(json, "born", "^\\d{4}-\\d{2}-\\d{2}$")
    }
}

/// An author as the API returns it: everything but what clients only send.
struct AuthorResponse: Encodable, Sendable {
    let item: Author

    init(_ item: Author) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case email
        case born
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id.uuidString.lowercased(), forKey: .id)
        try container.encode(item.name, forKey: .name)
        try container.encode(item.email, forKey: .email)
        try container.encode(item.born, forKey: .born)
    }
}
