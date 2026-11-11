// An author as the service and its storage handle it.

import Foundation

/// An author as the service and its storage handle it.
struct Author: Sendable, Equatable {
    var id: UUID = UUID()
    var name: String?
    var email: String?
    var born: String?
}
