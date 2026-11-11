// An item as the service and its storage handle it.

import Foundation

/// An item as the service and its storage handle it.
struct Item: Sendable, Equatable {
    var id: Int64 = 0
    var name: String?
    var price: Decimal?
    var supplierEmail: String?
    var categoryId: Int64?
    var stock: Int32?
}
