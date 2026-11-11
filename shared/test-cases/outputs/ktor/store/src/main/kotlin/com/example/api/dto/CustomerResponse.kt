package com.example.api.dto

import com.example.api.common.JsonDateTime
import com.example.api.model.Address
import com.example.api.model.Customer
import kotlinx.serialization.Serializable

/** A customer as the API returns it. */
@Serializable
data class CustomerResponse(
    val id: Long,
    val name: String?,
    val email: String?,
    val phone: String? = null,
    val address: Address?,
    val createdAt: JsonDateTime?,
) {
    companion object {
        /** The response of a stored customer: everything but what clients only send. */
        fun from(item: Customer) = CustomerResponse(
            id = item.id,
            name = item.name,
            email = item.email,
            phone = item.phone,
            address = item.address,
            createdAt = item.createdAt,
        )
    }
}
