package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonKind
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that changes part of a category: only the fields sent change. */
@Serializable
data class CategoryUpdate(
    val name: String? = null,
    val parentId: Long? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.notNull(json, "name")
            checks.kind(json, "name", JsonKind.TEXT)
            checks.length(json, "name", 1, 80)
            checks.kind(json, "parentId", JsonKind.WHOLE)
        }
    }
}
