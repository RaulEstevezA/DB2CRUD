package com.example.api.repository

import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.common.compareFieldValues
import com.example.api.common.sameValue
import com.example.api.model.Customer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Keeps customers in memory: they are lost when the application stops. Use it to try the API. */
class InMemoryCustomerRepository : CustomerRepository {
    private val items = ConcurrentHashMap<Long, Customer>()
    private val lastKey = AtomicLong()

    /** The value of a field by its JSON name, for filters and sorting. */
    private fun value(item: Customer, field: String): Any? = when (field) {
        "id" -> item.id
        "name" -> item.name
        "email" -> item.email
        "password" -> item.password
        "phone" -> item.phone
        "address" -> item.address
        "createdAt" -> item.createdAt
        else -> null
    }

    override suspend fun list(query: ListQuery): ListResult<Customer> {
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

    override suspend fun get(key: Long): Customer? = items[key]?.copy()

    override suspend fun add(item: Customer): Customer {
        val stored = item.copy(id = lastKey.incrementAndGet())
        items[stored.id] = stored
        return stored.copy()
    }

    override suspend fun update(item: Customer): Customer {
        items[item.id] = item.copy()
        return item.copy()
    }

    override suspend fun delete(key: Long) {
        items.remove(key)
    }
}
