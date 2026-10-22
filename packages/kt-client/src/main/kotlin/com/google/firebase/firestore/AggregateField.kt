package com.google.firebase.firestore

sealed class AggregateField {

    class CountAggregateField internal constructor() : AggregateField() {
        override fun toString(): String = "AggregateField.count()"
    }

    class SumAggregateField internal constructor(val field: String) : AggregateField() {
        override fun toString(): String = "AggregateField.sum($field)"
    }

    class AverageAggregateField internal constructor(val field: String) : AggregateField() {
        override fun toString(): String = "AggregateField.average($field)"
    }

    companion object {
        private val COUNT_INSTANCE = CountAggregateField()

        @JvmStatic
        fun count(): CountAggregateField = COUNT_INSTANCE

        @JvmStatic
        fun sum(field: String): SumAggregateField = SumAggregateField(field)

        @JvmStatic
        fun average(field: String): AverageAggregateField = AverageAggregateField(field)
    }
}
