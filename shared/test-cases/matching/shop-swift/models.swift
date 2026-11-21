import Foundation

enum ProductStatus: String, Codable {
    case draft = "draft"
    case live = "live"
}

/// A customer of the shop
struct Customer: Codable {
    let id: Int
    let email: String
    let passwordHash: String
    let createdAt: Date
}

struct CategoryDto: Codable {
    var id: Int
    var name: String
}

struct Product: Codable {
    var id: Int
    var name: String
    var price: Decimal
    var status: ProductStatus
    var categoryName: String
    var tagIds: [Int]
}

struct TagEntity: Codable {
    var id: Int
    var label: String
}
