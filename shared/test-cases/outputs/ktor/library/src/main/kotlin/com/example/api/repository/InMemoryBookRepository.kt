package com.example.api.repository

import com.example.api.common.JsonUuid
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.common.compareFieldValues
import com.example.api.common.sameValue
import com.example.api.model.Book
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Keeps books in memory: they are lost when the application stops. Use it to try the API. */
class InMemoryBookRepository : BookRepository {
    private val items = ConcurrentHashMap<JsonUuid, Book>()

    /** The value of a field by its JSON name, for filters and sorting. */
    private fun value(item: Book, field: String): Any? = when (field) {
        "id" -> item.id
        "title" -> item.title
        "isbn" -> item.isbn
        "authorId" -> item.authorId
        "genre" -> item.genre
        "pages" -> item.pages
        "published" -> item.published
        "available" -> item.available
        else -> null
    }

    override suspend fun list(query: ListQuery): ListResult<Book> {
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

    override suspend fun get(key: JsonUuid): Book? = items[key]?.copy()

    override suspend fun add(item: Book): Book {
        val stored = item.copy(id = UUID.randomUUID())
        items[stored.id] = stored
        return stored.copy()
    }

    override suspend fun update(item: Book): Book {
        items[item.id] = item.copy()
        return item.copy()
    }

    override suspend fun delete(key: JsonUuid) {
        items.remove(key)
    }
}
