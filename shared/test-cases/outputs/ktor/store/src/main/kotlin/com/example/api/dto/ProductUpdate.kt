package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that changes part of a product: only the fields sent change. */
@Serializable
data class ProductUpdate(
    val sku: String? = null,
    val name: String? = null,
    val description: String? = null,
    val price: Double? = null,
    val stock: Double? = null,
    val active: Boolean? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.notNull(json, "sku")
            checks.kind(json, "sku", JsonKind.TEXT)
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.notNull(json, "description")
            checks.kind(json, "description", JsonKind.TEXT)
            checks.notNull(json, "price")
            checks.kind(json, "price", JsonKind.NUMBER)
            checks.notNull(json, "stock")
            checks.kind(json, "stock", JsonKind.NUMBER)
            checks.notNull(json, "active")
            checks.kind(json, "active", JsonKind.BOOLEAN)
        }
    }
}
