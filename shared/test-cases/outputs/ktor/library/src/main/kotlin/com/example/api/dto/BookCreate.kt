package com.example.api.dto

import com.example.api.common.Checks
import com.example.api.common.JsonDate
import com.example.api.common.JsonKind
import com.example.api.common.JsonUuid
import com.example.api.model.Genre
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** Body of a request that creates or replaces a book. */
@Serializable
data class BookCreate(
    val title: String? = null,
    val isbn: String? = null,
    val authorId: JsonUuid? = null,
    val genre: Genre? = null,
    val pages: Int? = null,
    val published: JsonDate? = null,
    val available: Boolean? = null,
) {
    companion object {
        /** What the body must meet, checked on its JSON before it is read. */
        fun rules(checks: Checks, json: JsonObject) {
            checks.required(json, "title")
            checks.notNull(json, "title")
            checks.kind(json, "title", JsonKind.TEXT)
            checks.length(json, "title", 1, 200)
            checks.required(json, "isbn")
            checks.notNull(json, "isbn")
            checks.kind(json, "isbn", JsonKind.TEXT)
            checks.pattern(json, "isbn", Regex("^[0-9]{13}\$"))
            checks.required(json, "authorId")
            checks.notNull(json, "authorId")
            checks.kind(json, "authorId", JsonKind.TEXT)
            checks.required(json, "genre")
            checks.notNull(json, "genre")
            checks.kind(json, "genre", JsonKind.TEXT)
            checks.required(json, "pages")
            checks.notNull(json, "pages")
            checks.kind(json, "pages", JsonKind.WHOLE)
            checks.range(json, "pages", "1", "5000", false, false)
            checks.kind(json, "published", JsonKind.TEXT)
            checks.pattern(json, "published", Regex("^\\d{4}-\\d{2}-\\d{2}\$"))
            checks.notNull(json, "available")
            checks.kind(json, "available", JsonKind.BOOLEAN)
        }
    }
}
