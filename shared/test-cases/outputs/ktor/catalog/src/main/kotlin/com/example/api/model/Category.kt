package com.example.api.model

/** A category as the service and its storage handle it. */
data class Category(
    var id: Long = 0L,
    var name: String? = null,
    var parentId: Long? = null,
)
