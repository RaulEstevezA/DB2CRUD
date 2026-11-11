// A category as the service and its storage handle it.

import Foundation

/// A category as the service and its storage handle it.
struct Category: Sendable, Equatable {
    var id: Int64 = 0
    var name: String?
    var parentId: Int64?
}
