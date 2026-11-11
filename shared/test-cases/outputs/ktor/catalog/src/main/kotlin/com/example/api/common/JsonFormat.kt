package com.example.api.common

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.math.BigDecimal
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import java.util.UUID

/**
 * How the API reads and writes JSON: a field the contract does not describe is an error, and an optional field
 * without a value is left out of answers (its default is null).
 */
val JsonFormat = Json {
    ignoreUnknownKeys = false
    encodeDefaults = false
}

/** A decimal number, written in JSON as a number. */
typealias JsonDecimal = @Serializable(with = DecimalSerializer::class) BigDecimal

/** A date, written in JSON as "2024-01-15". */
typealias JsonDate = @Serializable(with = DateSerializer::class) LocalDate

/** A moment, written in JSON in ISO 8601 ("2024-01-15T10:30:00Z"). */
typealias JsonDateTime = @Serializable(with = DateTimeSerializer::class) Instant

/** A UUID, written in JSON as text. */
typealias JsonUuid = @Serializable(with = UuidSerializer::class) UUID

/** The JSON text of a value, which must be a string. */
private fun Decoder.jsonText(what: String): String {
    val element = (this as JsonDecoder).decodeJsonElement()
    if (element !is JsonPrimitive || !element.isString) throw SerializationException("Must be $what")
    return element.content
}

object DecimalSerializer : KSerializer<BigDecimal> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Decimal", PrimitiveKind.DOUBLE)

    override fun deserialize(decoder: Decoder): BigDecimal {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        if (element !is JsonPrimitive || element.isString) throw SerializationException("Must be a number")
        return element.content.toBigDecimalOrNull() ?: throw SerializationException("Must be a number")
    }

    // Without trailing zeros and never in scientific notation: 2.50 is 2.5, 100 is 100
    override fun serialize(encoder: Encoder, value: BigDecimal) =
        (encoder as JsonEncoder).encodeJsonElement(JsonPrimitive(BigDecimal(value.stripTrailingZeros().toPlainString())))
}

object DateSerializer : KSerializer<LocalDate> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Date", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): LocalDate = try {
        LocalDate.parse(decoder.jsonText("a date"))
    } catch (error: DateTimeParseException) {
        throw SerializationException("Must be a date (YYYY-MM-DD)")
    }

    override fun serialize(encoder: Encoder, value: LocalDate) = encoder.encodeString(value.toString())
}

object DateTimeSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("DateTime", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): Instant = try {
        OffsetDateTime.parse(decoder.jsonText("a date-time")).toInstant()
    } catch (error: DateTimeParseException) {
        throw SerializationException("Must be a date-time in ISO 8601")
    }

    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
}

object UuidSerializer : KSerializer<UUID> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("Uuid", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): UUID = try {
        UUID.fromString(decoder.jsonText("a UUID"))
    } catch (error: IllegalArgumentException) {
        throw SerializationException("Must be a UUID")
    }

    override fun serialize(encoder: Encoder, value: UUID) = encoder.encodeString(value.toString())
}

/** Reads and writes an enum as its number in JSON; a number no entry has is an error. */
open class NumberEnumSerializer<T : Enum<T>>(name: String, private val entries: List<T>, private val number: (T) -> Long) : KSerializer<T> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor(name, PrimitiveKind.LONG)

    override fun deserialize(decoder: Decoder): T {
        val element = (decoder as JsonDecoder).decodeJsonElement()
        val value = (element as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull
        return entries.firstOrNull { number(it) == value }
            ?: throw SerializationException("Must be one of: ${entries.joinToString { number(it).toString() }}")
    }

    override fun serialize(encoder: Encoder, value: T) = encoder.encodeLong(number(value))
}
