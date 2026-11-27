package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AggregateQuery internal constructor(
    val query: Query,
    val fields: List<AggregateField>
) {
    fun get(source: AggregateSource = AggregateSource.SERVER): Task<AggregateQuerySnapshot> {
        query.firestore.ensureClientActive()
        if (!query.firestore.offlineCoordinator.isNetworkEnabled) {
            return Tasks.forException(
                FirebaseFirestoreException(
                    "Failed to get aggregate query result because the client is offline.",
                    FirebaseFirestoreException.Code.UNAVAILABLE
                )
            )
        }
        val tcs = TaskCompletionSource<AggregateQuerySnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)

        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val targetDesc = query.toTargetDescriptor()
                val isOnlyCount = fields.size == 1 && fields[0] is AggregateField.CountAggregateField

                if (isOnlyCount) {
                    val res = query.firestore.bridgeClient.op(
                        method = "count",
                        params = mapOf("source" to targetDesc),
                        actAs = query.firestore.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val resMap = res as? Map<String, Any?> ?: emptyMap()
                    val countVal = (resMap["count"] as? Number)?.toLong() ?: 0L
                    tcs.setResult(
                        AggregateQuerySnapshot(
                            query = this@AggregateQuery,
                            countValue = countVal,
                            data = mapOf(AggregateField.count().alias to countVal)
                        )
                    )
                } else {
                    val spec = LinkedHashMap<String, Map<String, Any?>>()
                    for (field in fields) {
                        spec[field.alias] = toWireDescriptor(field)
                    }
                    val res = query.firestore.bridgeClient.op(
                        method = "aggregate",
                        params = mapOf("source" to targetDesc, "spec" to spec),
                        actAs = query.firestore.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val resMap = res as? Map<String, Any?> ?: emptyMap()
                    @Suppress("UNCHECKED_CAST")
                    val rawData = (resMap["data"] as? Map<String, Any?>) ?: emptyMap()
                    @Suppress("UNCHECKED_CAST")
                    val encodedData = resMap["encodedData"] as? Map<String, Any?>

                    val resolvedData = LinkedHashMap<String, Any?>()
                    for (alias in spec.keys) {
                        val rawEntry = if (encodedData != null && encodedData.containsKey(alias)) {
                            ValueCodec.decodeValue(encodedData[alias])
                        } else {
                            ValueCodec.decodeValue(rawData[alias])
                        }
                        resolvedData[alias] = rawEntry
                    }

                    val hasCountField = fields.any { it is AggregateField.CountAggregateField }
                    val countVal: Long? = if (hasCountField) {
                        val rawCount = resolvedData[AggregateField.count().alias] ?: resMap["count"]
                        (rawCount as? Number)?.toLong() ?: 0L
                    } else {
                        (resMap["count"] as? Number)?.toLong()
                    }
                    if (hasCountField && countVal != null) {
                        resolvedData[AggregateField.count().alias] = countVal
                    }

                    tcs.setResult(
                        AggregateQuerySnapshot(
                            query = this@AggregateQuery,
                            countValue = countVal,
                            data = resolvedData
                        )
                    )
                }
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }

        return tcs.task
    }

    private fun toWireDescriptor(field: AggregateField): Map<String, Any?> {
        return when (field) {
            is AggregateField.CountAggregateField -> mapOf("kind" to "count")
            is AggregateField.SumAggregateField -> {
                if (field.fieldPath.segments.any { it.contains('.') }) {
                    mapOf(
                        "kind" to "sum",
                        "field" to field.field,
                        "path" to field.fieldPath.segments
                    )
                } else {
                    mapOf("kind" to "sum", "field" to field.field)
                }
            }
            is AggregateField.AverageAggregateField -> {
                if (field.fieldPath.segments.any { it.contains('.') }) {
                    mapOf(
                        "kind" to "average",
                        "field" to field.field,
                        "path" to field.fieldPath.segments
                    )
                } else {
                    mapOf("kind" to "average", "field" to field.field)
                }
            }
        }
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
