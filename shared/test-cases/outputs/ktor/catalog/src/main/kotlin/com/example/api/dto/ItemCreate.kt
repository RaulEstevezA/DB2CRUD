package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonDecimal
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that creates or replaces an item. */
@Serializable
data class ItemCreate(
    val name: String? = null,
    val price: JsonDecimal? = null,
    val supplierEmail: String? = null,
    val categoryId: Long? = null,
    val stock: Int? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "name")
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.length(json, "name", 3, 120)
            checks.required(json, "price")
            checks.notNull(json, "price")
            checks.kind(json, "price", JsonKind.NUMBER)
            checks.range(json, "price", "0", null, false, false)
            checks.required(json, "supplierEmail")
            checks.notNull(json, "supplierEmail")
            checks.kind(json, "supplierEmail", JsonKind.TEXT)
            checks.email(json, "supplierEmail")
            checks.required(json, "categoryId")
            checks.notNull(json, "categoryId")
            checks.kind(json, "categoryId", JsonKind.WHOLE)
            checks.required(json, "stock")
            checks.notNull(json, "stock")
            checks.kind(json, "stock", JsonKind.WHOLE)
            checks.range(json, "stock", "0", null, false, false)
        }
    }
}
