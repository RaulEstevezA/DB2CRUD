package com.example.api.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Values of OrderStatus, with the value each one has in JSON. */
@Serializable
enum class OrderStatus(val value: String) {
    @SerialName("pending")
    PENDING("pending"),

    @SerialName("paid")
    PAID("paid"),

    @SerialName("shipped")
    SHIPPED("shipped"),

    @SerialName("cancelled")
    CANCELLED("cancelled");

    companion object {
        /** The entry with this value in JSON, or null when none has it. */
        fun fromValue(value: String): OrderStatus? = entries.firstOrNull { it.value == value }
    }
}
