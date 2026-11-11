package com.example.api.model

import com.example.api.common.JsonDate
import com.example.api.common.JsonUuid

/** A book as the service and its storage handle it. */
data class Book(
    var id: JsonUuid = JsonUuid(0L, 0L),
    var title: String? = null,
    var isbn: String? = null,
    var authorId: JsonUuid? = null,
    var genre: Genre? = null,
    var pages: Int? = null,
    var published: JsonDate? = null,
    var available: Boolean? = null,
)
