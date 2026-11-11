package com.example.api.model

import com.example.api.common.JsonDate
import com.example.api.common.JsonUuid

/** An author as the service and its storage handle it. */
data class Author(
    var id: JsonUuid = JsonUuid(0L, 0L),
    var name: String? = null,
    var email: String? = null,
    var born: JsonDate? = null,
)
