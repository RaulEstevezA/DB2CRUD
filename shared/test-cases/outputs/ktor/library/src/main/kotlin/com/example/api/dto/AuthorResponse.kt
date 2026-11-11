package com.example.api.dto

import com.example.api.common.JsonDate
import com.example.api.common.JsonUuid
import com.example.api.model.Author
import kotlinx.serialization.Serializable

/** An author as the API returns it. */
@Serializable
data class AuthorResponse(
    val id: JsonUuid,
    val name: String?,
    val email: String?,
    val born: JsonDate?,
) {
    companion object {
        /** The response of a stored author: everything but what clients only send. */
        fun from(item: Author) = AuthorResponse(
            id = item.id,
            name = item.name,
            email = item.email,
            born = item.born,
        )
    }
}
