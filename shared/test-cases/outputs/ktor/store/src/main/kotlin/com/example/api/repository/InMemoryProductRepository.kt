package com.example.api.repository

import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.common.compareFieldValues
import com.example.api.common.sameValue
import com.example.api.model.Product
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Keeps products in memory: they are lost when the application stops. Use it to try the API. */
class InMemoryProductRepository : ProductRepository {
    private val items = ConcurrentHashMap<Long, Product>()
    private val lastKey = AtomicLong()

    /** The value of a field by its JSON name, for filters and sorting. */
    private fun value(item: Product, field: String): Any? = when (field) {
        "id" -> item.id
        "sku" -> item.sku
        "name" -> item.name
        "description" -> item.description
        "price" -> item.price
        "stock" -> item.stock
        "active" -> item.active
        else -> null
    }

    override suspend fun list(query: ListQuery): ListResult<Product> {
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

    override suspend fun get(key: Long): Product? = items[key]?.copy()

    override suspend fun add(item: Product): Product {
        val stored = item.copy(id = lastKey.incrementAndGet())
        items[stored.id] = stored
        return stored.copy()
    }

    override suspend fun update(item: Product): Product {
        items[item.id] = item.copy()
        return item.copy()
    }

    override suspend fun delete(key: Long) {
        items.remove(key)
    }
}
