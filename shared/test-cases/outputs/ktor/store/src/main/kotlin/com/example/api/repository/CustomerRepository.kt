package com.example.api.repository

import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.model.Customer

/** Where customers are kept. The service depends only on this interface. */
interface CustomerRepository {
    /** Items equal to every filter, in order, within the window; and how many match. */
    suspend fun list(query: ListQuery): ListResult<Customer>

    /** The item with this key, or null when there is none. */
    suspend fun get(key: Long): Customer?

    /** Stores a new item and assigns its key; returns it as stored. */
    suspend fun add(item: Customer): Customer

    /** Stores the new state of an existing item and returns it. */
    suspend fun update(item: Customer): Customer

    /** Removes an existing item. */
    suspend fun delete(key: Long)
}
