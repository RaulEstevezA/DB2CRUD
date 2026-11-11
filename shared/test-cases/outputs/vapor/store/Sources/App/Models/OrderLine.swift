// OrderLine, embedded in the resources that hold it.

import Foundation

/// OrderLine, embedded in the resources that hold it.
struct OrderLine: Codable, Sendable, Equatable {
    var productId: Int64?
    var quantity: Double?
    var unitPrice: Double?

    enum CodingKeys: String, CodingKey {
        case productId
        case quantity
        case unitPrice
    }

    func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(productId, forKey: .productId)
        try container.encode(quantity, forKey: .quantity)
        try container.encode(unitPrice, forKey: .unitPrice)
    }

    /// What the body must meet, checked on its JSON before it is decoded.
    static func rules(_ checks: inout Checks, _ json: [String: JSONValue]) {
        checks.only(json, ["productId", "quantity", "unitPrice"])
        checks.required(json, "productId")
        checks.notNull(json, "productId")
        checks.kind(json, "productId", .whole)
        checks.required(json, "quantity")
        checks.notNull(json, "quantity")
        checks.kind(json, "quantity", .number)
        checks.required(json, "unitPrice")
        checks.notNull(json, "unitPrice")
        checks.kind(json, "unitPrice", .number)
    }
}
