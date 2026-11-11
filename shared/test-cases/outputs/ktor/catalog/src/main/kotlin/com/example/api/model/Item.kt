package com.example.api.model

import com.example.api.common.JsonDecimal

/** An item as the service and its storage handle it. */
data class Item(
    var id: Long = 0L,
    var name: String? = null,
    var price: JsonDecimal? = null,
    var supplierEmail: String? = null,
    var categoryId: Long? = null,
    var stock: Int? = null,
)
