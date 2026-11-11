package com.example.api.service

import com.example.api.common.ApiException
import com.example.api.common.Body
import com.example.api.common.Clock
import com.example.api.common.ListQuery
import com.example.api.common.ListResult
import com.example.api.dto.CustomerCreate
import com.example.api.dto.CustomerUpdate
import com.example.api.model.Customer
import com.example.api.repository.CustomerRepository

/** Rules of customers: what each operation checks and changes. */
class CustomerService(
    private val repository: CustomerRepository,
) {
    private suspend fun find(key: Long): Customer =
        repository.get(key) ?: throw ApiException.notFound("customer")

    /** Sets every field a creation or a replacement carries: the value sent, or its default when it was not sent. */
    private fun apply(item: Customer, body: Body<CustomerCreate>) {
        val data = body.value
        item.name = data.name
        item.email = data.email
        item.password = data.password
        item.phone = data.phone
        item.address = data.address
    }

    /** Sets the fields a partial change carries; the others stay as they are. */
    private fun applyChanges(item: Customer, body: Body<CustomerUpdate>) {
        val data = body.value
        if (body.has("name")) item.name = data.name
        if (body.has("email")) item.email = data.email
        if (body.has("password")) item.password = data.password
        if (body.has("phone")) item.phone = data.phone
        if (body.has("address")) item.address = data.address
    }

    /** List customers. */
    suspend fun listCustomers(query: ListQuery): ListResult<Customer> = repository.list(query)

    /** Get a customer. */
    suspend fun getCustomer(key: Long): Customer = find(key)

    /** Create a customer. */
    suspend fun createCustomer(body: Body<CustomerCreate>): Customer {
        val item = Customer()
        apply(item, body)
        item.createdAt = Clock.now()
        return repository.add(item)
    }

    /** Replace a customer: every field the client may send takes the value of the body. */
    suspend fun replaceCustomer(key: Long, body: Body<CustomerCreate>): Customer {
        val item = find(key)
        apply(item, body)
        return repository.update(item)
    }

    /** Update part of a customer: only the fields in the body change. */
    suspend fun updateCustomer(key: Long, body: Body<CustomerUpdate>): Customer {
        val item = find(key)
        applyChanges(item, body)
        return repository.update(item)
    }

    /** Delete a customer. */
    suspend fun deleteCustomer(key: Long) {
        find(key)
        repository.delete(key)
    }
}
