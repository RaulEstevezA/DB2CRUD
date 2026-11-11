package com.example.api.common

import kotlinx.serialization.Serializable
import java.math.BigDecimal

/** What a list asks a repository for: equality filters by JSON field name, an order and a window. */
data class ListQuery(
    val filters: Map<String, Any>,
    val sortField: String?,
    val descending: Boolean,
    val offset: Int,
    val limit: Int?,
) {
    companion object {
        /** "-createdAt" sorts by createdAt in descending order. */
        fun of(filters: Map<String, Any>, sort: String?, offset: Int = 0, limit: Int? = null): ListQuery {
            if (sort.isNullOrEmpty()) return ListQuery(filters, null, false, offset, limit)
            val descending = sort.startsWith("-")
            return ListQuery(filters, if (descending) sort.substring(1) else sort, descending, offset, limit)
        }
    }
}

/** A window of items and how many match, whatever the window. */
data class ListResult<T>(val items: List<T>, val total: Long)

/** One page of a list, as the API returns it. */
@Serializable
data class PageResponse<T>(val items: List<T>, val total: Long, val page: Int, val size: Int)

/** Whether two values are the same for a filter: decimals compare by value (2.5 is 2.50). */
fun sameValue(a: Any?, b: Any?): Boolean = if (a is BigDecimal && b is BigDecimal) a.compareTo(b) == 0 else a == b

/** Orders two values of a field; both are of the same type. */
@Suppress("UNCHECKED_CAST")
fun compareFieldValues(a: Any?, b: Any?): Int = compareValues(a as Comparable<Any>?, b as Comparable<Any>?)
