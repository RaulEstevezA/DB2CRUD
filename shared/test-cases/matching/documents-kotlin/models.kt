package shop.models

import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate

enum class Level { basic, gold }

enum class LineStatus { pending, sent }

data class Location(val latitude: Double, val longitude: Double)

data class Address(val street: String, val zipCode: String, val location: Location? = null)

data class Customer(
    val id: String,
    val email: String,
    val level: Level?,
    val since: Instant,
    val address: Address,
    val tags: List<String>,
)

class Discount {
    var reason: String = ""
    var percent: Double = 0.0
}

class OrderLine {
    var id: String? = null
    var sku: String = ""
    var quantity: Int = 0
    var price: BigDecimal = BigDecimal.ZERO
    var status: LineStatus? = null
    var discounts: List<Discount> = emptyList()
}

data class Shipping(val carrier: String, val sentOn: LocalDate)

data class Order(val id: String, val code: String, val lines: List<OrderLine>, val shipping: Shipping? = null)

data class Parcel(val weight: Double, val size: String, val fragile: Boolean)

data class Shipment(val id: String, val parcel: Parcel, val stops: List<String>)
