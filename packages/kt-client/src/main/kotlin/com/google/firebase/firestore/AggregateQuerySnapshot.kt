package com.google.firebase.firestore

class AggregateQuerySnapshot internal constructor(
    val query: AggregateQuery,
    private val countValue: Long?,
    private val data: Map<String, Any?> = emptyMap()
) {
    internal constructor(
        query: AggregateQuery,
        count: Long,
        data: Map<String, Any?> = emptyMap()
    ) : this(query, countValue = count, data = if (data.isEmpty()) mapOf(AggregateField.count().alias to count) else data)

    val count: Long
        get() = get(AggregateField.count())

    fun get(aggregateField: AggregateField.CountAggregateField): Long {
        requireRequested(aggregateField)
        return countValue ?: (data[aggregateField.alias] as? Number)?.toLong() ?: 0L
    }

    fun get(aggregateField: AggregateField): Any? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField)
            is AggregateField.SumAggregateField -> (data[aggregateField.alias] as? Number)?.toDouble()
            is AggregateField.AverageAggregateField -> (data[aggregateField.alias] as? Number)?.toDouble()
        }
    }

    fun get(aggregateField: AggregateField.SumAggregateField): Double? {
        requireRequested(aggregateField)
        return (data[aggregateField.alias] as? Number)?.toDouble()
    }

    fun get(aggregateField: AggregateField.AverageAggregateField): Double? {
        requireRequested(aggregateField)
        return (data[aggregateField.alias] as? Number)?.toDouble()
    }

    fun getDouble(aggregateField: AggregateField): Double? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField).toDouble()
            else -> (data[aggregateField.alias] as? Number)?.toDouble()
        }
    }

    fun getLong(aggregateField: AggregateField): Long? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField)
            else -> (data[aggregateField.alias] as? Number)?.toLong()
        }
    }

    private fun requireRequested(aggregateField: AggregateField) {
        val inQuery = query.fields.contains(aggregateField) || data.containsKey(aggregateField.alias)
        require(inQuery) {
            "'$aggregateField' was not requested in the aggregation"
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AggregateQuerySnapshot) return false
        return query == other.query && countValue == other.countValue && data == other.data
    }

    override fun hashCode(): Int {
        var result = query.hashCode()
        result = 31 * result + (countValue?.hashCode() ?: 0)
        result = 31 * result + data.hashCode()
        return result
    }

    override fun toString(): String =
        "AggregateQuerySnapshot(count=$countValue, data=$data)"
}
