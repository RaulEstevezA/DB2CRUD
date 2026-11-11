package com.example.api.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Values of Genre, with the value each one has in JSON. */
@Serializable
enum class Genre(val value: String) {
    @SerialName("novel")
    NOVEL("novel"),

    @SerialName("essay")
    ESSAY("essay"),

    @SerialName("poetry")
    POETRY("poetry"),

    @SerialName("science")
    SCIENCE("science");

    companion object {
        /** The entry with this value in JSON, or null when none has it. */
        fun fromValue(value: String): Genre? = entries.firstOrNull { it.value == value }
    }
}
