package com.example.api.model

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Address, embedded in the resources that hold it. */
@Serializable
data class Address(
    val street: String? = null,
    val city: String? = null,
    val postalCode: String? = null,
    val country: String? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "street")
            checks.notNull(json, "street")
            checks.kind(json, "street", JsonKind.TEXT)
            checks.required(json, "city")
            checks.notNull(json, "city")
            checks.kind(json, "city", JsonKind.TEXT)
            checks.required(json, "postalCode")
            checks.notNull(json, "postalCode")
            checks.kind(json, "postalCode", JsonKind.TEXT)
            checks.required(json, "country")
            checks.notNull(json, "country")
            checks.kind(json, "country", JsonKind.TEXT)
        }
    }
}
