package com.example.api.repository

import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.model.Book

/** Where books are kept. The service depends only on this interface. */
interface BookRepository {
    /** Items equal to every filter, in order, within the window; and how many match. */
    suspend fun list(query: ListQuery): ListResult<Book>

    /** The item with this key, or null when there is none. */
    suspend fun get(key: JsonUuid): Book?

    /** Stores a new item and assigns its key; returns it as stored. */
    suspend fun add(item: Book): Book

    /** Stores the new state of an existing item and returns it. */
    suspend fun update(item: Book): Book

    /** Removes an existing item. */
    suspend fun delete(key: JsonUuid)
}
