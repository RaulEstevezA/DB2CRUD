package com.example.api.model

import com.example.api.common.JsonDateTime

/** An order as the service and its storage handle it. */
data class Order(
    var id: Long = 0L,
    var customerId: Long? = null,
    var lines: List<OrderLine>? = null,
    var status: OrderStatus? = null,
    var total: Double? = null,
    var notes: String? = null,
    var createdAt: JsonDateTime? = null,
    var updatedAt: JsonDateTime? = null,
)
