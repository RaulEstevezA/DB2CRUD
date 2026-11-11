package com.example.api.repository

import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.model.Author

/** Where authors are kept. The service depends only on this interface. */
interface AuthorRepository {
    /** Items equal to every filter, in order, within the window; and how many match. */
    suspend fun list(query: ListQuery): ListResult<Author>

    /** The item with this key, or null when there is none. */
    suspend fun get(key: JsonUuid): Author?

    /** Stores a new item and assigns its key; returns it as stored. */
    suspend fun add(item: Author): Author

    /** Stores the new state of an existing item and returns it. */
    suspend fun update(item: Author): Author

    /** Removes an existing item. */
    suspend fun delete(key: JsonUuid)
}
