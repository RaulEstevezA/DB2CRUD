package com.example.api.model

/** A product as the service and its storage handle it. */
data class Product(
    var id: Long = 0L,
    var sku: String? = null,
    var name: String? = null,
    var description: String? = null,
    var price: Double? = null,
    var stock: Double? = null,
    var active: Boolean? = null,
)
