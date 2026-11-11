// A book as the service and its storage handle it.

import Foundation

/// A book as the service and its storage handle it.
struct Book: Sendable, Equatable {
    var id: UUID = UUID()
    var title: String?
    var isbn: String?
    var authorId: UUID?
    var genre: Genre?
    var pages: Int32?
    var published: String?
    var available: Bool?
}
