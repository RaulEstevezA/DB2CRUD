// Values of OrderStatus.

/// Values of OrderStatus, with the value each one has in JSON.
enum OrderStatus: String, Codable, Sendable, CaseIterable, Comparable {
    case pending = "pending"
    case paid = "paid"
    case shipped = "shipped"
    case cancelled = "cancelled"

    static func < (lhs: OrderStatus, rhs: OrderStatus) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}
