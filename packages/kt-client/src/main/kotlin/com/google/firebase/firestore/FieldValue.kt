package com.google.firebase.firestore

import dev.pyric.codecs.SentinelValidator

/**
 * Sentinel values that can be used when writing document fields with set() or update().
 */
abstract class FieldValue internal constructor() {

    internal class ServerTimestampSentinel : FieldValue() {
        override fun toString(): String = "FieldValue.serverTimestamp()"
    }

    internal class DeleteSentinel : FieldValue() {
        override fun toString(): String = "FieldValue.delete()"
    }

    internal class IncrementSentinel(val operand: Number) : FieldValue() {
        override fun toString(): String = "FieldValue.increment($operand)"
    }

    internal class ArrayUnionSentinel(val elements: List<Any?>) : FieldValue() {
        override fun toString(): String = "FieldValue.arrayUnion($elements)"
    }

    internal class ArrayRemoveSentinel(val elements: List<Any?>) : FieldValue() {
        override fun toString(): String = "FieldValue.arrayRemove($elements)"
    }

    companion object {
        private val SERVER_TIMESTAMP_INSTANCE = ServerTimestampSentinel()
        private val DELETE_INSTANCE = DeleteSentinel()

        fun serverTimestamp(): FieldValue = SERVER_TIMESTAMP_INSTANCE

        fun delete(): FieldValue = DELETE_INSTANCE

        fun increment(l: Long): FieldValue = IncrementSentinel(l)

        fun increment(d: Double): FieldValue = IncrementSentinel(d)

        fun arrayUnion(vararg elements: Any?): FieldValue {
            SentinelValidator.validateNoArraySentinels(elements, "arrayUnion")
            return ArrayUnionSentinel(elements.toList())
        }

        fun arrayRemove(vararg elements: Any?): FieldValue {
            SentinelValidator.validateNoArraySentinels(elements, "arrayRemove")
            return ArrayRemoveSentinel(elements.toList())
        }
    }
}
