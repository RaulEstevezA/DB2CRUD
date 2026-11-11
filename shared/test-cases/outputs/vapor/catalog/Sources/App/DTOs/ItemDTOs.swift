// Request bodies and responses of items.

import Foundation

/// Body of a request that creates or replaces an item.
struct ItemCreate: Decodable, Sendable {
    var name: String?
    var price: Decimal?
    var supplierEmail: String?
    var categoryId: Int64?
    var stock: Int32?

    enum CodingKeys: String, CodingKey {
        case name
        case price
        case supplierEmail
        case categoryId
        case stock
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "price", "supplierEmail", "categoryId", "stock"])
        checks.required(json, "name")
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 3, max: 120)
        checks.required(json, "price")
        checks.notNull(json, "price")
        checks.kind(json, "price", .number)
        checks.range(json, "price", min: 0, max: nil, minExclusive: false, maxExclusive: false)
        checks.required(json, "supplierEmail")
        checks.notNull(json, "supplierEmail")
        checks.kind(json, "supplierEmail", .text)
        checks.email(json, "supplierEmail")
        checks.required(json, "categoryId")
        checks.notNull(json, "categoryId")
        checks.kind(json, "categoryId", .whole)
        checks.required(json, "stock")
        checks.notNull(json, "stock")
        checks.kind(json, "stock", .whole)
        checks.range(json, "stock", min: 0, max: nil, minExclusive: false, maxExclusive: false)
    }
}

/// Body of a request that changes part of an item: only the fields sent change.
struct ItemUpdate: Decodable, Sendable {
    var name: String?
    var price: Decimal?
    var supplierEmail: String?
    var categoryId: Int64?
    var stock: Int32?

    enum CodingKeys: String, CodingKey {
        case name
        case price
        case supplierEmail
        case categoryId
        case stock
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "price", "supplierEmail", "categoryId", "stock"])
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.length(json, "name", min: 3, max: 120)
        checks.notNull(json, "price")
        checks.kind(json, "price", .number)
        checks.range(json, "price", min: 0, max: nil, minExclusive: false, maxExclusive: false)
        checks.notNull(json, "supplierEmail")
        checks.kind(json, "supplierEmail", .text)
        checks.email(json, "supplierEmail")
        checks.notNull(json, "categoryId")
        checks.kind(json, "categoryId", .whole)
        checks.notNull(json, "stock")
        checks.kind(json, "stock", .whole)
        checks.range(json, "stock", min: 0, max: nil, minExclusive: false, maxExclusive: false)
    }
}

/// An item as the API returns it: everything but what clients only send.
struct ItemResponse: Encodable, Sendable {
    let item: Item

    init(_ item: Item) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case price
        case supplierEmail
        case categoryId
        case stock
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id, forKey: .id)
        try container.encode(item.name, forKey: .name)
        try container.encode(item.price, forKey: .price)
        try container.encode(item.supplierEmail, forKey: .supplierEmail)
        try container.encode(item.categoryId, forKey: .categoryId)
        try container.encode(item.stock, forKey: .stock)
    }
}
