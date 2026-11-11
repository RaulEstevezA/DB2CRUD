// A product as the service and its storage handle it.

import Foundation

/// A product as the service and its storage handle it.
struct Product: Sendable, Equatable {
    var id: Int64 = 0
    var sku: String?
    var name: String?
    var description: String?
    var price: Double?
    var stock: Double?
    var active: Bool?
}
