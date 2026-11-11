package com.example.api.dto

import com.example.api.model.Category
import kotlinx.serialization.Serializable

/** A category as the API returns it. */
@Serializable
data class CategoryResponse(
    val id: Long,
    val name: String?,
    val parentId: Long? = null,
) {
    companion object {
        /** The response of a stored category: everything but what clients only send. */
        fun from(item: Category) = CategoryResponse(
            id = item.id,
            name = item.name,
            parentId = item.parentId,
        )
    }
}
