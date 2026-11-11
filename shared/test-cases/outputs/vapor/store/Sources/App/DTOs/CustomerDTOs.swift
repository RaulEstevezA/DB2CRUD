// Request bodies and responses of customers.

import Foundation

/// Body of a request that creates or replaces a customer.
struct CustomerCreate: Decodable, Sendable {
    var name: String?
    var email: String?
    var password: String?
    var phone: String?
    var address: Address?

    enum CodingKeys: String, CodingKey {
        case name
        case email
        case password
        case phone
        case address
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "email", "password", "phone", "address"])
        checks.required(json, "name")
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.required(json, "email")
        checks.notNull(json, "email")
        checks.kind(json, "email", .text)
        checks.required(json, "password")
        checks.notNull(json, "password")
        checks.kind(json, "password", .text)
        checks.notNull(json, "phone")
        checks.kind(json, "phone", .text)
        checks.required(json, "address")
        checks.notNull(json, "address")
        checks.kind(json, "address", .object)
        checks.nested(json, "address", Address.rules)
    }
}

/// Body of a request that changes part of a customer: only the fields sent change.
struct CustomerUpdate: Decodable, Sendable {
    var name: String?
    var email: String?
    var password: String?
    var phone: String?
    var address: Address?

    enum CodingKeys: String, CodingKey {
        case name
        case email
        case password
        case phone
        case address
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["name", "email", "password", "phone", "address"])
        checks.notNull(json, "name")
        checks.kind(json, "name", .text)
        checks.notNull(json, "email")
        checks.kind(json, "email", .text)
        checks.notNull(json, "password")
        checks.kind(json, "password", .text)
        checks.notNull(json, "phone")
        checks.kind(json, "phone", .text)
        checks.notNull(json, "address")
        checks.kind(json, "address", .object)
        checks.nested(json, "address", Address.rules)
    }
}

/// A customer as the API returns it: everything but what clients only send.
struct CustomerResponse: Encodable, Sendable {
    let item: Customer

    init(_ item: Customer) {
        self.item = item
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case email
        case phone
        case address
        case createdAt
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(item.id, forKey: .id)
        try container.encode(item.name, forKey: .name)
        try container.encode(item.email, forKey: .email)
        try container.encodeIfPresent(item.phone, forKey: .phone)
        try container.encode(item.address, forKey: .address)
        try container.encode(item.createdAt, forKey: .createdAt)
    }
}
