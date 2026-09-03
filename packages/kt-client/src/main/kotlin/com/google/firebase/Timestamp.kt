package com.google.firebase

import java.util.Date

/**
 * A Timestamp represents a point in time independent of any time zone or calendar,
 * represented as seconds and fractions of seconds at nanosecond resolution in UTC Epoch time.
 */
class Timestamp(val seconds: Long, val nanoseconds: Int) : Comparable<Timestamp> {

    init {
        validate(seconds, nanoseconds)
    }

    constructor(date: Date) : this(
        date.time.floorDiv(1000L),
        date.time.mod(1000) * 1_000_000
    )

    fun toDate(): Date {
        return Date(seconds * 1000 + nanoseconds / 1000000)
    }

    override fun compareTo(other: Timestamp): Int {
        val secCmp = seconds.compareTo(other.seconds)
        return if (secCmp != 0) secCmp else nanoseconds.compareTo(other.nanoseconds)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Timestamp) return false
        return seconds == other.seconds && nanoseconds == other.nanoseconds
    }

    override fun hashCode(): Int {
        var result = (seconds xor (seconds ushr 32)).toInt()
        result = 31 * result + nanoseconds
        return result
    }

    override fun toString(): String {
        return "Timestamp(seconds=$seconds, nanoseconds=$nanoseconds)"
    }

    companion object {
        fun now(): Timestamp {
            val nowMs = System.currentTimeMillis()
            return Timestamp(Date(nowMs))
        }

        private fun validate(seconds: Long, nanoseconds: Int) {
            require(nanoseconds in 0 until 1_000_000_000) {
                "Timestamp nanoseconds out of range: $nanoseconds"
            }
            require(seconds in -62135596800L..253402300799L) {
                "Timestamp seconds out of range: $seconds"
            }
        }
    }
}
