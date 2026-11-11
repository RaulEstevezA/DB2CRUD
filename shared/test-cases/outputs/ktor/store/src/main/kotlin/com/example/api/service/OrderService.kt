package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.Clock
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.OrderCreate
import com.example.api.dto.OrderUpdate
import com.example.api.model.Order
import com.example.api.repository.CustomerRepository
import com.example.api.repository.OrderRepository
import com.example.api.repository.ProductRepository

/** Rules of orders: what each operation checks and changes. */
class OrderService(
    private val repository: OrderRepository,
    private val customerRepository: CustomerRepository,
    private val productRepository: ProductRepository,
) {
    private suspend fun find(key: Long): Order =
        repository.get(key) ?: throw ApiException.notFound("order")

    /** Every reference must point to a stored item. */
    private suspend fun checkReferences(item: Order) {
        item.customerId?.let { reference0 ->
            if (customerRepository.get(reference0) == null) throw ApiException.invalid("customerId", "No Customer has this key")
        }
        item.lines?.forEach { item0 ->
            item0.productId?.let { reference1 ->
                if (productRepository.get(reference1) == null) throw ApiException.invalid("lines.productId", "No Product has this key")
            }
        }
    }

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Order, body: Body<OrderCreate>) {
        val data = body.value
        item.customerId = data.customerId
        item.lines = data.lines
        item.status = data.status
        item.total = data.total
        item.notes = data.notes
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Order, body: Body<OrderUpdate>) {
        val data = body.value
        if (body.has("customerId")) item.customerId = data.customerId
        if (body.has("lines")) item.lines = data.lines
        if (body.has("status")) item.status = data.status
        if (body.has("total")) item.total = data.total
        if (body.has("notes")) item.notes = data.notes
    }

    /** List orders. */
    suspend fun listOrders(query: ListQuery): ListResult<Order> = repository.list(query)

    /** Get an order. */
    suspend fun getOrder(key: Long): Order = find(key)

    /** Create an order. */
    suspend fun createOrder(body: Body<OrderCreate>): Order {
        val item = Order()
        apply(item, body)
        checkReferences(item)
        item.createdAt = Clock.now()
        item.updatedAt = Clock.now()
        return repository.add(item)
    }

    /** Replace an order: every field the client may send takes the value of the body. */
    suspend fun replaceOrder(key: Long, body: Body<OrderCreate>): Order {
        val item = find(key)
        apply(item, body)
        checkReferences(item)
        item.updatedAt = Clock.now()
        return repository.update(item)
    }

    /** Update part of an order: only the fields in the body change. */
    suspend fun updateOrder(key: Long, body: Body<OrderUpdate>): Order {
        val item = find(key)
        applyChanges(item, body)
        checkReferences(item)
        item.updatedAt = Clock.now()
        return repository.update(item)
    }

    /** Delete an order. */
    suspend fun deleteOrder(key: Long) {
        find(key)
        repository.delete(key)
    }
}
