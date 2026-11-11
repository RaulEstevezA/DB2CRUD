package com.example.api.dto

import com.example.api.common.JsonDateTime
import com.example.api.model.Order
import com.example.api.model.OrderLine
import com.example.api.model.OrderStatus
import kotlinx.serialization.Serializable

/** An order as the API returns it. */
@Serializable
data class OrderResponse(
    val id: Long,
    val customerId: Long?,
    val lines: List<OrderLine>?,
    val status: OrderStatus?,
    val total: Double?,
    val notes: String? = null,
    val createdAt: JsonDateTime?,
    val updatedAt: JsonDateTime?,
) {
    companion object {
        /** The response of a stored order: everything but what clients only send. */
        fun from(item: Order) = OrderResponse(
            id = item.id,
            customerId = item.customerId,
            lines = item.lines,
            status = item.status,
            total = item.total,
            notes = item.notes,
            createdAt = item.createdAt,
            updatedAt = item.updatedAt,
        )
    }
}
