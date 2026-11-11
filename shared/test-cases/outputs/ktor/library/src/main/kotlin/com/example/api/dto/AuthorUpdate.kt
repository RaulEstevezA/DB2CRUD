package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonDate
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that changes part of an author: only the fields sent change. */
@Serializable
data class AuthorUpdate(
    val name: String? = null,
    val email: String? = null,
    val born: JsonDate? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.length(json, "name", 2, 120)
            checks.kind(json, "email", JsonKind.TEXT)
            checks.email(json, "email")
            checks.kind(json, "born", JsonKind.TEXT)
            checks.pattern(json, "born", Regex("^\\d{4}-\\d{2}-\\d{2}\$"))
        }
    }
}
