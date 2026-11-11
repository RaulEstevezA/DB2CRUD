// Values of Genre.

/// Values of Genre, with the value each one has in JSON.
enum Genre: String, Codable, Sendable, CaseIterable, Comparable {
    case novel = "novel"
    case essay = "essay"
    case poetry = "poetry"
    case science = "science"

    static func < (lhs: Genre, rhs: Genre) -> Bool {
        lhs.rawValue < rhs.rawValue
    }
}
