package com.example.api.model

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** OrderLine, embedded in the resources that hold it. */
@Serializable
data class OrderLine(
    val productId: Long? = null,
    val quantity: Double? = null,
    val unitPrice: Double? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "productId")
            checks.notNull(json, "productId")
            checks.kind(json, "productId", JsonKind.WHOLE)
            checks.required(json, "quantity")
            checks.notNull(json, "quantity")
            checks.kind(json, "quantity", JsonKind.NUMBER)
            checks.required(json, "unitPrice")
            checks.notNull(json, "unitPrice")
            checks.kind(json, "unitPrice", JsonKind.NUMBER)
        }
    }
}
