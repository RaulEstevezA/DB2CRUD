package shop.models

import java.math.BigDecimal
import java.time.OffsetDateTime

enum class ProductStatus(val value: String) {
    DRAFT("draft"),
    LIVE("live"),
}

/** A customer of the shop */
data class Customer(
    val id: Long,
    val email: String,
    val passwordHash: String,
    val createdAt: OffsetDateTime,
)

data class CategoryDto(val id: Int, val name: String)

class Product {
    var id: Long = 0
    var name: String = ""
    var price: BigDecimal = BigDecimal.ZERO
    var status: ProductStatus = ProductStatus.DRAFT
    var categoryName: String = ""
    var tagIds: List<Int> = emptyList()
}

data class TagEntity(val id: Int, val label: String)
