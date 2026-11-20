package com.google.firebase.firestore

import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.JsonCodec
import dev.pyric.codecs.PojoCodec
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec

class Transaction internal constructor(
    private val firestore: FirebaseFirestore
) {
    internal val reads = mutableListOf<Map<String, Any?>>()
    internal val writes = mutableListOf<Map<String, Any?>>()

    fun get(documentRef: DocumentReference): DocumentSnapshot {
        val snapshot = Tasks.await(documentRef.get())
        val serializedData: Map<String, Any?>? = if (!snapshot.exists()) {
            null
        } else {
            snapshot.rawWireData ?: snapshot.getData()?.let {
                mapOf("json" to JsonCodec.encodeToString(ValueCodec.encodeValue(it)))
            }
        }
        reads.add(
            mapOf(
                "path" to documentRef.path,
                "data" to serializedData
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
            else -> PojoCodec.serialize(data)
        }
        SentinelValidator.validateNoDelete(map, options.isMerge)
        SentinelValidator.validateNoNestedArraySentinels(map)
        val entry = mutableMapOf<String, Any?>(
            "method" to "set",
            "path" to documentRef.path,
            "data" to ValueCodec.encodeWriteData(map)
        )
        val wireOptions = options.toWireOptions()
        if (wireOptions != null) {
            entry["options"] = wireOptions
        }
        writes.add(entry)
        return this
    }

    fun update(documentRef: DocumentReference, data: Map<String, Any?>): Transaction {
        SentinelValidator.validateNoNestedArraySentinels(data)
        writes.add(
            mapOf(
                "method" to "update",
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
                "method" to "delete",
                "path" to documentRef.path
            )
        )
        return this
    }

    fun interface Function<TResult> {
        fun apply(transaction: Transaction): TResult
    }
}
