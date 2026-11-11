package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import com.example.api.model.OrderLine
import com.example.api.model.OrderStatus
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that creates or replaces an order. */
@Serializable
data class OrderCreate(
    val customerId: Long? = null,
    val lines: List<OrderLine>? = null,
    val status: OrderStatus? = null,
    val total: Double? = null,
    val notes: String? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "customerId")
            checks.notNull(json, "customerId")
            checks.kind(json, "customerId", JsonKind.WHOLE)
            checks.required(json, "lines")
            checks.notNull(json, "lines")
            checks.kind(json, "lines", JsonKind.LIST)
            checks.each(json, "lines", OrderLine::rules)
            checks.required(json, "status")
            checks.notNull(json, "status")
            checks.kind(json, "status", JsonKind.TEXT)
            checks.required(json, "total")
            checks.notNull(json, "total")
            checks.kind(json, "total", JsonKind.NUMBER)
            checks.kind(json, "notes", JsonKind.TEXT)
        }
    }
}
