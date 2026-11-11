// A customer as the service and its storage handle it.

import Foundation

/// A customer as the service and its storage handle it.
struct Customer: Sendable, Equatable {
    var id: Int64 = 0
    var name: String?
    var email: String?
    var password: String?
    var phone: String?
    var address: Address?
    var createdAt: Date?
}
