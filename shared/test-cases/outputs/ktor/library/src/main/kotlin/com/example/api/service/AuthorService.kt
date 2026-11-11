package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.AuthorCreate
import com.example.api.dto.AuthorUpdate
import com.example.api.model.Author
import com.example.api.repository.AuthorRepository

/** Rules of authors: what each operation checks and changes. */
class AuthorService(
    private val repository: AuthorRepository,
) {
    private suspend fun find(key: JsonUuid): Author =
        repository.get(key) ?: throw ApiException.notFound("author")

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Author, body: Body<AuthorCreate>) {
        val data = body.value
        item.name = data.name
        item.email = if (body.has("email")) data.email else null
        item.born = if (body.has("born")) data.born else null
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Author, body: Body<AuthorUpdate>) {
        val data = body.value
        if (body.has("name")) item.name = data.name
        if (body.has("email")) item.email = data.email
        if (body.has("born")) item.born = data.born
    }

    /** List authors. */
    suspend fun listAuthors(query: ListQuery): ListResult<Author> = repository.list(query)

    /** Get an author. */
    suspend fun getAuthor(key: JsonUuid): Author = find(key)

    /** Create an author. */
    suspend fun createAuthor(body: Body<AuthorCreate>): Author {
        val item = Author()
        apply(item, body)
        return repository.add(item)
    }

    /** Replace an author: every field the client may send takes the value of the body. */
    suspend fun replaceAuthor(key: JsonUuid, body: Body<AuthorCreate>): Author {
        val item = find(key)
        apply(item, body)
        return repository.update(item)
    }

    /** Update part of an author: only the fields in the body change. */
    suspend fun updateAuthor(key: JsonUuid, body: Body<AuthorUpdate>): Author {
        val item = find(key)
        applyChanges(item, body)
        return repository.update(item)
    }

    /** Delete an author. */
    suspend fun deleteAuthor(key: JsonUuid) {
        find(key)
        repository.delete(key)
    }
}
