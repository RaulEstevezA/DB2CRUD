package com.example.api.dto

import com.example.api.common.JsonDecimal
import com.example.api.model.Item
import kotlinx.serialization.Serializable

/** An item as the API returns it. */
@Serializable
data class ItemResponse(
    val id: Long,
    val name: String?,
    val price: JsonDecimal?,
    val supplierEmail: String?,
    val categoryId: Long?,
    val stock: Int?,
) {
    companion object {
        /** The response of a stored item: everything but what clients only send. */
        fun from(item: Item) = ItemResponse(
            id = item.id,
            name = item.name,
            price = item.price,
            supplierEmail = item.supplierEmail,
            categoryId = item.categoryId,
            stock = item.stock,
        )
    }
}
