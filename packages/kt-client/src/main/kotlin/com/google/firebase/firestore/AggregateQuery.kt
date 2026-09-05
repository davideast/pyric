package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AggregateQuery internal constructor(
    val query: Query,
    val fields: List<AggregateField>
) {
    fun get(source: AggregateSource = AggregateSource.SERVER): Task<AggregateQuerySnapshot> {
        val tcs = TaskCompletionSource<AggregateQuerySnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)

        scope.launch {
            try {
                val targetDesc = query.toTargetDescriptor()
                val isOnlyCount = fields.size == 1 && fields[0] is AggregateField.CountAggregateField

                if (isOnlyCount) {
                    val res = query.firestore.bridgeClient.op(
                        method = "count",
                        params = mapOf("target" to targetDesc),
                        actAs = query.firestore.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val resMap = res as? Map<String, Any?> ?: emptyMap()
                    val countVal = (resMap["count"] as? Number)?.toLong() ?: 0L
                    tcs.setResult(AggregateQuerySnapshot(this@AggregateQuery, countVal))
                } else {
                    val aggsPayload = fields.map { f ->
                        when (f) {
                            is AggregateField.CountAggregateField -> mapOf("kind" to "count")
                            is AggregateField.SumAggregateField -> mapOf("kind" to "sum", "field" to f.field)
                            is AggregateField.AverageAggregateField -> mapOf("kind" to "average", "field" to f.field)
                        }
                    }
                    val res = query.firestore.bridgeClient.op(
                        method = "aggregate",
                        params = mapOf("target" to targetDesc, "aggregates" to aggsPayload),
                        actAs = query.firestore.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val resMap = res as? Map<String, Any?> ?: emptyMap()
                    val countVal = (resMap["count"] as? Number)?.toLong() ?: 0L
                    @Suppress("UNCHECKED_CAST")
                    val dataVal = (resMap["data"] as? Map<String, Any?>) ?: emptyMap()
                    tcs.setResult(AggregateQuerySnapshot(this@AggregateQuery, countVal, dataVal))
                }
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }

        return tcs.task
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is AggregateQuery) return false
        return query == other.query && fields == other.fields
    }

    override fun hashCode(): Int {
        var result = query.hashCode()
        result = 31 * result + fields.hashCode()
        return result
    }
}
