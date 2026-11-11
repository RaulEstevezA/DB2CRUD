// Request bodies and responses of categories.

import Foundation

/// Body of a request that creates or replaces a category.
struct CategoryCreate: Decodable, Sendable {
    var name: String?
    var parentId: Int64?

    enum CodingKeys: String, CodingKey {
        case name
        case parentId
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "parentId"])
        checks.required(json, "name")
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 1, max: 80)
        checks.kind(json, "parentId", .whole)
    }
}

/// Body of a request that changes part of a category: only the fields sent change.
struct CategoryUpdate: Decodable, Sendable {
    var name: String?
    var parentId: Int64?

    enum CodingKeys: String, CodingKey {
        case name
        case parentId
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "parentId"])
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 1, max: 80)
        checks.kind(json, "parentId", .whole)
    }
}

/// A category as the API returns it: everything but what clients only send.
struct CategoryResponse: Encodable, Sendable {
    let item: Category

    init(_ item: Category) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case parentId
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id, forKey: .id)
        try container.encode(item.name, forKey: .name)
        try container.encodeIfPresent(item.parentId, forKey: .parentId)
    }
}
