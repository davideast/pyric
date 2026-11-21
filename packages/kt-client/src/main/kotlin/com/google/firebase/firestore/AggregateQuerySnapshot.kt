package com.google.firebase.firestore

class AggregateQuerySnapshot internal constructor(
    val query: AggregateQuery,
    private val countValue: Long?,
    data: Map<String, Any?> = emptyMap()
) {
    private val normalizedData: Map<String, Any?> = normalizeData(query, countValue, data)

    internal constructor(
        query: AggregateQuery,
        count: Long,
        data: Map<String, Any?> = emptyMap()
    ) : this(
        query = query,
        countValue = count,
        data = if (data.isEmpty()) mapOf(AggregateField.count().alias to count) else data
    )

    val count: Long
        get() = get(AggregateField.count())

    fun get(aggregateField: AggregateField.CountAggregateField): Long {
        requireRequested(aggregateField)
        return countValue ?: (normalizedData[aggregateField.alias] as? Number)?.toLong() ?: 0L
    }

    fun get(aggregateField: AggregateField): Any? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField)
            is AggregateField.SumAggregateField -> normalizeSumValue(normalizedData[aggregateField.alias])
            is AggregateField.AverageAggregateField -> get(aggregateField)
        }
    }

    fun get(aggregateField: AggregateField.AverageAggregateField): Double? {
        requireRequested(aggregateField)
        return getDouble(aggregateField)
    }

    fun getDouble(aggregateField: AggregateField): Double? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField).toDouble()
            else -> (normalizedData[aggregateField.alias] as? Number)?.toDouble()
        }
    }

    fun getLong(aggregateField: AggregateField): Long? {
        requireRequested(aggregateField)
        return when (aggregateField) {
            is AggregateField.CountAggregateField -> get(aggregateField)
            else -> (normalizedData[aggregateField.alias] as? Number)?.toLong()
        }
    }

    private fun requireRequested(aggregateField: AggregateField) {
        val inQuery = query.fields.contains(aggregateField) || normalizedData.containsKey(aggregateField.alias)
        require(inQuery) {
            "'$aggregateField' was not requested in the aggregation"
        }
    }

    companion object {
        internal fun normalizeSumValue(value: Any?): Number? {
            return when (value) {
                is Byte -> value.toLong()
                is Short -> value.toLong()
                is Int -> value.toLong()
                is Long -> value
                is Float -> value.toDouble()
                is Double -> value
                else -> null
            }
        }

        private fun normalizeData(
            query: AggregateQuery,
            countValue: Long?,
            rawData: Map<String, Any?>
        ): Map<String, Any?> {
            if (rawData.isEmpty()) return emptyMap()
            val fieldsByAlias = query.fields.associateBy { it.alias }
            val out = LinkedHashMap<String, Any?>(rawData.size)
            for ((alias, raw) in rawData) {
                out[alias] = when (fieldsByAlias[alias]) {
                    is AggregateField.CountAggregateField -> countValue ?: (raw as? Number)?.toLong() ?: 0L
                    is AggregateField.SumAggregateField -> normalizeSumValue(raw)
                    is AggregateField.AverageAggregateField -> (raw as? Number)?.toDouble()
                    null -> when (raw) {
                        is Byte -> raw.toLong()
                        is Short -> raw.toLong()
                        is Int -> raw.toLong()
                        is Float -> raw.toDouble()
                        else -> raw
                    }
                }
            }
            return out
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AggregateQuerySnapshot) return false
        return query == other.query && countValue == other.countValue && normalizedData == other.normalizedData
    }

    override fun hashCode(): Int {
        var result = query.hashCode()
        result = 31 * result + (countValue?.hashCode() ?: 0)
        result = 31 * result + normalizedData.hashCode()
        return result
    }

    override fun toString(): String =
        "AggregateQuerySnapshot(count=$countValue, data=$normalizedData)"
}
