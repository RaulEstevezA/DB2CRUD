package com.example.api.repository

import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.common.compareFieldValues
import com.example.api.common.sameValue
import com.example.api.model.Author
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Keeps authors in memory: they are lost when the application stops. Use it to try the API. */
class InMemoryAuthorRepository : AuthorRepository {
    private val items = ConcurrentHashMap<JsonUuid, Author>()

    /** The value of a field by its JSON name, for filters and sorting. */
    private fun value(item: Author, field: String): Any? = when (field) {
        "id" -> item.id
        "name" -> item.name
        "email" -> item.email
        "born" -> item.born
        else -> null
    }

    override suspend fun list(query: ListQuery): ListResult<Author> {
        var found = items.values
            .filter { item -> query.filters.all { (field, value) -> sameValue(value(item, field), value) } }
            .sortedWith { a, b -> compareFieldValues(a.id, b.id) }
        val field = query.sortField
        if (field != null) {
            val present = found.filter { value(it, field) != null }
                .sortedWith { a, b -> compareFieldValues(value(a, field), value(b, field)) }
            // Items without a value go last, whatever the order
            found = (if (query.descending) present.reversed() else present) + found.filter { value(it, field) == null }
        }
        val window = found.drop(query.offset).let { if (query.limit == null) it else it.take(query.limit) }
        return ListResult(window.map { it.copy() }, found.size.toLong())
    }

    override suspend fun get(key: JsonUuid): Author? = items[key]?.copy()

    override suspend fun add(item: Author): Author {
        val stored = item.copy(id = UUID.randomUUID())
        items[stored.id] = stored
        return stored.copy()
    }

    override suspend fun update(item: Author): Author {
        items[item.id] = item.copy()
        return item.copy()
    }

    override suspend fun delete(key: JsonUuid) {
        items.remove(key)
    }
}
