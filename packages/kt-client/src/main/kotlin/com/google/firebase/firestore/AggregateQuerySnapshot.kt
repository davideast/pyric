package com.google.firebase.firestore

class AggregateQuerySnapshot internal constructor(
    val query: AggregateQuery,
    val count: Long,
    private val data: Map<String, Any?> = emptyMap()
) {
    fun get(aggregateField: AggregateField): Any? {
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> count
            is AggregateField.SumAggregateField -> (data["sum_" + aggregateField.field] as? Number)?.toDouble()
            is AggregateField.AverageAggregateField -> (data["avg_" + aggregateField.field] as? Number)?.toDouble()
        }
    }

    fun get(aggregateField: AggregateField.SumAggregateField): Double? {
        return (data["sum_" + aggregateField.field] as? Number)?.toDouble()
    }

    fun get(aggregateField: AggregateField.AverageAggregateField): Double? {
        return (data["avg_" + aggregateField.field] as? Number)?.toDouble()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AggregateQuerySnapshot) return false
        return query == other.query && count == other.count && data == other.data
    }

    override fun hashCode(): Int {
        var result = query.hashCode()
        result = 31 * result + count.hashCode()
        result = 31 * result + data.hashCode()
        return result
    }

    override fun toString(): String =
        "AggregateQuerySnapshot(count=$count, data=$data)"
}
