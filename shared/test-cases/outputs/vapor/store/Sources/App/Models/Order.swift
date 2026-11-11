// An order as the service and its storage handle it.

import Foundation

/// An order as the service and its storage handle it.
struct Order: Sendable, Equatable {
    var id: Int64 = 0
    var customerId: Int64?
    var lines: [OrderLine]?
    var status: OrderStatus?
    var total: Double?
    var notes: String?
    var createdAt: Date?
    var updatedAt: Date?
}
