package com.google.firebase.firestore

sealed class AggregateField {
    internal abstract val alias: String

    class CountAggregateField internal constructor() : AggregateField() {
        override val alias: String = "count"

        override fun equals(other: Any?): Boolean = other is CountAggregateField

        override fun hashCode(): Int = alias.hashCode()

        override fun toString(): String = "AggregateField.count()"
    }

    class SumAggregateField internal constructor(
        internal val fieldPath: FieldPath
    ) : AggregateField() {
        val field: String = fieldPath.canonicalString
        override val alias: String = buildFieldAlias("sum", fieldPath)

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is SumAggregateField) return false
            return fieldPath == other.fieldPath
        }

        override fun hashCode(): Int = 31 * "sum".hashCode() + fieldPath.hashCode()

        override fun toString(): String = "AggregateField.sum($field)"
    }

    class AverageAggregateField internal constructor(
        internal val fieldPath: FieldPath
    ) : AggregateField() {
        val field: String = fieldPath.canonicalString
        override val alias: String = buildFieldAlias("avg", fieldPath)

        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is AverageAggregateField) return false
            return fieldPath == other.fieldPath
        }

        override fun hashCode(): Int = 31 * "avg".hashCode() + fieldPath.hashCode()

        override fun toString(): String = "AggregateField.average($field)"
    }

    companion object {
        private val COUNT_INSTANCE = CountAggregateField()

        private fun buildFieldAlias(prefix: String, fieldPath: FieldPath): String {
            val segments = fieldPath.segments
            val needsEscaping = segments.any { it.contains('.') || it.contains('\\') }
            if (!needsEscaping) {
                return "${prefix}_${fieldPath.canonicalString}"
            }
            val escaped = segments.joinToString(".") { segment ->
                segment.replace("\\", "\\\\").replace(".", "\\.")
            }
            return "${prefix}_$escaped"
        }

        @JvmStatic
        fun count(): CountAggregateField = COUNT_INSTANCE

        @JvmStatic
        fun sum(field: String): SumAggregateField =
            SumAggregateField(FieldPath.fromDotSeparated(field))

        @JvmStatic
        fun sum(fieldPath: FieldPath): SumAggregateField =
            SumAggregateField(fieldPath)

        @JvmStatic
        fun average(field: String): AverageAggregateField =
            AverageAggregateField(FieldPath.fromDotSeparated(field))

        @JvmStatic
        fun average(fieldPath: FieldPath): AverageAggregateField =
            AverageAggregateField(fieldPath)
    }
}
