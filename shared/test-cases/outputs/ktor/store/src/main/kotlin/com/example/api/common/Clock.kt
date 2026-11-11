package com.example.api.common

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

/** The time the server writes, in UTC. */
object Clock {
    /** Now, to the microsecond: what databases keep, so a later read gives the same value. */
    fun now(): Instant = Instant.now().truncatedTo(ChronoUnit.MICROS)

    fun today(): LocalDate = LocalDate.now(ZoneOffset.UTC)

    /** Now as ISO 8601 text, for a text field the server fills. */
    fun text(): String = Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()
}
