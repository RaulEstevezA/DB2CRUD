package com.example.api.dto

import com.example.api.model.Product
import kotlinx.serialization.Serializable

/** A product as the API returns it. */
@Serializable
data class ProductResponse(
    val id: Long,
    val sku: String?,
    val name: String?,
    val description: String? = null,
    val price: Double?,
    val stock: Double?,
    val active: Boolean?,
) {
    companion object {
        /** The response of a stored product: everything but what clients only send. */
        fun from(item: Product) = ProductResponse(
            id = item.id,
            sku = item.sku,
            name = item.name,
            description = item.description,
            price = item.price,
            stock = item.stock,
            active = item.active,
        )
    }
}
