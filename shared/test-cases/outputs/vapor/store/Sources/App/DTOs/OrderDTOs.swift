// Request bodies and responses of orders.

import Foundation

/// Body of a request that creates or replaces an order.
struct OrderCreate: Decodable, Sendable {
    var customerId: Int64?
    var lines: [OrderLine]?
    var status: OrderStatus?
    var total: Double?
    var notes: String?

    enum CodingKeys: String, CodingKey {
        case customerId
        case lines
        case status
        case total
        case notes
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["customerId", "lines", "status", "total", "notes"])
        checks.required(json, "customerId")
        checks.notNull(json, "customerId")
        checks.kind(json, "customerId", .whole)
        checks.required(json, "lines")
        checks.notNull(json, "lines")
        checks.kind(json, "lines", .list)
        checks.each(json, "lines", OrderLine.rules)
        checks.required(json, "status")
        checks.notNull(json, "status")
        checks.kind(json, "status", .text)
        checks.required(json, "total")
        checks.notNull(json, "total")
        checks.kind(json, "total", .number)
        checks.kind(json, "notes", .text)
    }
}

/// Body of a request that changes part of an order: only the fields sent change.
struct OrderUpdate: Decodable, Sendable {
    var customerId: Int64?
    var lines: [OrderLine]?
    var status: OrderStatus?
    var total: Double?
    var notes: String?

    enum CodingKeys: String, CodingKey {
        case customerId
        case lines
        case status
        case total
        case notes
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["customerId", "lines", "status", "total", "notes"])
        checks.notNull(json, "customerId")
        checks.kind(json, "customerId", .whole)
        checks.notNull(json, "lines")
        checks.kind(json, "lines", .list)
        checks.each(json, "lines", OrderLine.rules)
        checks.notNull(json, "status")
        checks.kind(json, "status", .text)
        checks.notNull(json, "total")
        checks.kind(json, "total", .number)
        checks.kind(json, "notes", .text)
    }
}

/// An order as the API returns it: everything but what clients only send.
struct OrderResponse: Encodable, Sendable {
    let item: Order

    init(_ item: Order) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case customerId
        case lines
        case status
        case total
        case notes
        case createdAt
        case updatedAt
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id, forKey: .id)
        try container.encode(item.customerId, forKey: .customerId)
        try container.encode(item.lines, forKey: .lines)
        try container.encode(item.status, forKey: .status)
        try container.encode(item.total, forKey: .total)
        try container.encodeIfPresent(item.notes, forKey: .notes)
        try container.encode(item.createdAt, forKey: .createdAt)
        try container.encode(item.updatedAt, forKey: .updatedAt)
    }
}
