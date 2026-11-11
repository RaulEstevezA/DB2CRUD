// Address, embedded in the resources that hold it.

import Foundation

/// Address, embedded in the resources that hold it.
struct Address: Codable, Sendable, Equatable {
    var street: String?
    var city: String?
    var postalCode: String?
    var country: String?

    enum CodingKeys: String, CodingKey {
        case street
        case city
        case postalCode
        case country
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(street, forKey: .street)
        try container.encode(city, forKey: .city)
        try container.encode(postalCode, forKey: .postalCode)
        try container.encode(country, forKey: .country)
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["street", "city", "postalCode", "country"])
        checks.required(json, "street")
        checks.notNull(json, "street")
        checks.kind(json, "street", .text)
        checks.required(json, "city")
        checks.notNull(json, "city")
        checks.kind(json, "city", .text)
        checks.required(json, "postalCode")
        checks.notNull(json, "postalCode")
        checks.kind(json, "postalCode", .text)
        checks.required(json, "country")
        checks.notNull(json, "country")
        checks.kind(json, "country", .text)
    }
}
