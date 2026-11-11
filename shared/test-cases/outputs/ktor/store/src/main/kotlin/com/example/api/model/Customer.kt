package com.example.api.model

import com.example.api.common.JsonDateTime

/** A customer as the service and its storage handle it. */
data class Customer(
    var id: Long = 0L,
    var name: String? = null,
    var email: String? = null,
    var password: String? = null,
    var phone: String? = null,
    var address: Address? = null,
    var createdAt: JsonDateTime? = null,
)
