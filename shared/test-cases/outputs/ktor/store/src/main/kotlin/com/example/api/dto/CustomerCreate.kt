package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import com.example.api.model.Address
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that creates or replaces a customer. */
@Serializable
data class CustomerCreate(
    val name: String? = null,
    val email: String? = null,
    val password: String? = null,
    val phone: String? = null,
    val address: Address? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "name")
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.required(json, "email")
            checks.notNull(json, "email")
            checks.kind(json, "email", JsonKind.TEXT)
            checks.required(json, "password")
            checks.notNull(json, "password")
            checks.kind(json, "password", JsonKind.TEXT)
            checks.notNull(json, "phone")
            checks.kind(json, "phone", JsonKind.TEXT)
            checks.required(json, "address")
            checks.notNull(json, "address")
            checks.kind(json, "address", JsonKind.OBJECT)
            checks.nested(json, "address", Address::rules)
        }
    }
}
