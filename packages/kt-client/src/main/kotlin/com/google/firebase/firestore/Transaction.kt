package com.google.firebase.firestore

import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec

class Transaction internal constructor(
    private val firestore: FirebaseFirestore
) {
    internal val reads = mutableListOf<Map<String, Any?>>()
    internal val writes = mutableListOf<Map<String, Any?>>()

    fun get(documentRef: DocumentReference): DocumentSnapshot {
        val snapshot = Tasks.await(documentRef.get())
        reads.add(
            mapOf(
                "path" to documentRef.path,
                "data" to mapOf("json" to (snapshot.getData()?.let { dev.pyric.codecs.JsonCodec.encodeToString(it) } ?: "null"))
            )
        )
        return snapshot
    }

    fun set(documentRef: DocumentReference, data: Any): Transaction =
        set(documentRef, data, SetOptions.overwrite())

    @Suppress("UNCHECKED_CAST")
    fun set(documentRef: DocumentReference, data: Any, options: SetOptions): Transaction {
        val map = when (data) {
            is Map<*, *> -> data as Map<String, Any?>
            else -> throw IllegalArgumentException("Custom object serialization not yet supported in set()")
        }
        SentinelValidator.validateNoDelete(map, options.isMerge)
        writes.add(
            mapOf(
                "op" to "set",
                "path" to documentRef.path,
                "data" to ValueCodec.encodeWriteData(map),
                "merge" to options.isMerge
            )
        )
        return this
    }

    fun update(documentRef: DocumentReference, data: Map<String, Any?>): Transaction {
        writes.add(
            mapOf(
                "op" to "update",
                "path" to documentRef.path,
                "data" to ValueCodec.encodeWriteData(data)
            )
        )
        return this
    }

    fun update(documentRef: DocumentReference, field: String, value: Any?, vararg moreFieldsAndValues: Any?): Transaction {
        require(moreFieldsAndValues.size % 2 == 0) {
            "Missing value in call to update(). There must be an even number of arguments that alternate between field names and values"
        }
        val map = mutableMapOf<String, Any?>(field to value)
        for (i in moreFieldsAndValues.indices step 2) {
            map[moreFieldsAndValues[i] as String] = moreFieldsAndValues[i + 1]
        }
        return update(documentRef, map)
    }

    fun delete(documentRef: DocumentReference): Transaction {
        writes.add(
            mapOf(
                "op" to "delete",
                "path" to documentRef.path
            )
        )
        return this
    }

    fun interface Function<TResult> {
        fun apply(transaction: Transaction): TResult
    }
}
