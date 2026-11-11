package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that creates or replaces a product. */
@Serializable
data class ProductCreate(
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
            checks.required(json, "sku")
            checks.notNull(json, "sku")
            checks.kind(json, "sku", JsonKind.TEXT)
            checks.required(json, "name")
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.notNull(json, "description")
            checks.kind(json, "description", JsonKind.TEXT)
            checks.required(json, "price")
            checks.notNull(json, "price")
            checks.kind(json, "price", JsonKind.NUMBER)
            checks.required(json, "stock")
            checks.notNull(json, "stock")
            checks.kind(json, "stock", JsonKind.NUMBER)
            checks.required(json, "active")
            checks.notNull(json, "active")
            checks.kind(json, "active", JsonKind.BOOLEAN)
        }
    }
}
