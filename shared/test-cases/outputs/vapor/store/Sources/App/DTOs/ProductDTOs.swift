// Request bodies and responses of products.

import Foundation

/// Body of a request that creates or replaces a product.
struct ProductCreate: Decodable, Sendable {
    var sku: String?
    var name: String?
    var description: String?
    var price: Double?
    var stock: Double?
    var active: Bool?

    enum CodingKeys: String, CodingKey {
        case sku
        case name
        case description
        case price
        case stock
        case active
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["sku", "name", "description", "price", "stock", "active"])
        checks.required(json, "sku")
        checks.notNull(json, "sku")
        checks.kind(json, "sku", .text)
        checks.required(json, "name")
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.notNull(json, "description")
        checks.kind(json, "description", .text)
        checks.required(json, "price")
        checks.notNull(json, "price")
        checks.kind(json, "price", .number)
        checks.required(json, "stock")
        checks.notNull(json, "stock")
        checks.kind(json, "stock", .number)
        checks.required(json, "active")
        checks.notNull(json, "active")
        checks.kind(json, "active", .boolean)
    }
}

/// Body of a request that changes part of a product: only the fields sent change.
struct ProductUpdate: Decodable, Sendable {
    var sku: String?
    var name: String?
    var description: String?
    var price: Double?
    var stock: Double?
    var active: Bool?

    enum CodingKeys: String, CodingKey {
        case sku
        case name
        case description
        case price
        case stock
        case active
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["sku", "name", "description", "price", "stock", "active"])
        checks.notNull(json, "sku")
        checks.kind(json, "sku", .text)
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.notNull(json, "description")
        checks.kind(json, "description", .text)
        checks.notNull(json, "price")
        checks.kind(json, "price", .number)
        checks.notNull(json, "stock")
        checks.kind(json, "stock", .number)
        checks.notNull(json, "active")
        checks.kind(json, "active", .boolean)
    }
}

/// A product as the API returns it: everything but what clients only send.
struct ProductResponse: Encodable, Sendable {
    let item: Product

    init(_ item: Product) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case sku
        case name
        case description
        case price
        case stock
        case active
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id, forKey: .id)
        try container.encode(item.sku, forKey: .sku)
        try container.encode(item.name, forKey: .name)
        try container.encodeIfPresent(item.description, forKey: .description)
        try container.encode(item.price, forKey: .price)
        try container.encode(item.stock, forKey: .stock)
        try container.encode(item.active, forKey: .active)
    }
}
