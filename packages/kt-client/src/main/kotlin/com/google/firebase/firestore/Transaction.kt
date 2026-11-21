package com.google.firebase.firestore

import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.JsonCodec
import dev.pyric.codecs.PojoCodec
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.UUID
import java.util.concurrent.ExecutionException

class Transaction internal constructor(
    private val firestore: FirebaseFirestore
) {
    internal val txnId: String = "kt-txn-${UUID.randomUUID()}"
    internal val reads = mutableListOf<Map<String, Any?>>()
    internal val writes = mutableListOf<Map<String, Any?>>()

    fun get(documentRef: DocumentReference): DocumentSnapshot {
        if (writes.isNotEmpty()) {
            throw FirebaseFirestoreException(
                "Firestore transactions require all reads to be executed before all writes.",
                FirebaseFirestoreException.Code.INVALID_ARGUMENT
            )
        }
        val snapshot = readSnapshotForTransaction(documentRef)
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

    private fun readSnapshotForTransaction(documentRef: DocumentReference): DocumentSnapshot {
        val tcs = TaskCompletionSource<DocumentSnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = firestore.bridgeClient.op(
                    method = "getDoc",
                    params = mapOf("path" to documentRef.path, "txnId" to txnId),
                    actAs = firestore.getEffectiveAuthLens().toMap()
                )
                @Suppress("UNCHECKED_CAST")
                val resMap = res as? Map<String, Any?> ?: emptyMap()
                val docId = (resMap["id"] as? String) ?: documentRef.id
                val exists = resMap["exists"] == true
                val rawData = resMap["data"]
                val unpackedData = if (exists) {
                    DocumentDataEnvelope.unpack(rawData) { p -> firestore.document(p) }
                } else {
                    null
                }
                tcs.setResult(
                    DocumentSnapshot(
                        id = docId,
                        reference = documentRef,
                        exists = exists,
                        rawData = unpackedData,
                        metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false),
                        rawWireData = if (exists) DocumentDataEnvelope.extractEnvelope(rawData) else null
                    )
                )
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return try {
            Tasks.await(tcs.task)
        } catch (e: ExecutionException) {
            val cause = e.cause
            if (cause is FirebaseFirestoreException) {
                throw cause
            }
            if (cause is RuntimeException) {
                throw cause
            }
            throw e
        }
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
        val hasFieldPathArg = (moreFieldsAndValues.indices step 2).any { moreFieldsAndValues[it] is FieldPath }
        if (hasFieldPathArg) {
            return update(documentRef, FieldPath.fromDotSeparated(field), value, *moreFieldsAndValues)
        }
        val map = mutableMapOf<String, Any?>(field to value)
        for (i in moreFieldsAndValues.indices step 2) {
            val key = moreFieldsAndValues[i] as? String
                ?: throw IllegalArgumentException("Expected String or FieldPath key at argument index ${i + 2} in update().")
            map[key] = moreFieldsAndValues[i + 1]
        }
        return update(documentRef, map)
    }

    fun update(
        documentRef: DocumentReference,
        fieldPath: FieldPath,
        value: Any?,
        vararg moreFieldsAndValues: Any?
    ): Transaction {
        require(moreFieldsAndValues.size % 2 == 0) {
            "Missing value in call to update(). There must be an even number of arguments that alternate between field names and values"
        }
        val entries = mutableListOf<Pair<FieldPath, Any?>>(fieldPath to value)
        for (i in moreFieldsAndValues.indices step 2) {
            val fp = when (val key = moreFieldsAndValues[i]) {
                is FieldPath -> key
                is String -> FieldPath.fromDotSeparated(key)
                else -> throw IllegalArgumentException("Expected String or FieldPath key at argument index ${i + 2} in update().")
            }
            entries.add(fp to moreFieldsAndValues[i + 1])
        }
        entries.forEach { (_, fieldVal) -> SentinelValidator.validateNoNestedArraySentinels(fieldVal) }
        writes.add(
            mapOf(
                "method" to "update",
                "path" to documentRef.path,
                "fields" to entries.map { (fp, fieldVal) ->
                    mapOf(
                        "path" to fp.segments,
                        "value" to ValueCodec.encodeValue(fieldVal)
                    )
                }
            )
        )
        return this
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
