package com.example.api.dto

import com.example.api.common.JsonDate
import com.example.api.common.JsonUuid
import com.example.api.model.Book
import com.example.api.model.Genre
import kotlinx.serialization.Serializable

/** A book as the API returns it. */
@Serializable
data class BookResponse(
    val id: JsonUuid,
    val title: String?,
    val isbn: String?,
    val authorId: JsonUuid?,
    val genre: Genre?,
    val pages: Int?,
    val published: JsonDate?,
    val available: Boolean?,
) {
    companion object {
        /** The response of a stored book: everything but what clients only send. */
        fun from(item: Book) = BookResponse(
            id = item.id,
            title = item.title,
            isbn = item.isbn,
            authorId = item.authorId,
            genre = item.genre,
            pages = item.pages,
            published = item.published,
            available = item.available,
        )
    }
}
