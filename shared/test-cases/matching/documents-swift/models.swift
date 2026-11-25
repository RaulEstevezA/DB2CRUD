import Foundation

enum Level: String, Codable {
    case basic = "basic"
    case gold = "gold"
}

enum LineStatus: String, Codable {
    case pending = "pending"
    case sent = "sent"
}

struct Location: Codable {
    let latitude: Double
    let longitude: Double
}

struct Address: Codable {
    let street: String
    let zipCode: String
    let location: Location?
}

struct Customer: Codable {
    let id: String
    let email: String
    let level: Level?
    let since: Date
    let address: Address
    let tags: [String]
}

struct Discount: Codable {
    var reason: String
    var percent: Double
}

struct OrderLine: Codable {
    var id: String?
    var sku: String
    var quantity: Int
    var price: Decimal
    var status: LineStatus?
    var discounts: [Discount]
}

struct Shipping: Codable {
    let carrier: String
    let sentOn: Date
}

struct Order: Codable {
    let id: String
    let code: String
    let lines: [OrderLine]
    let shipping: Shipping?
}

struct Parcel: Codable {
    let weight: Double
    let size: String
    let fragile: Bool
}

struct Shipment: Codable {
    let id: String
    let parcel: Parcel
    let stops: [String]
}
