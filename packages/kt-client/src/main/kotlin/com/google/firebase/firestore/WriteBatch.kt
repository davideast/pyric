package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class WriteBatch internal constructor(private val firestore: FirebaseFirestore) {

    private sealed class Mutation {
        data class Set(val ref: DocumentReference, val data: Map<String, Any?>, val options: SetOptions) : Mutation()
        data class Update(val ref: DocumentReference, val data: Map<String, Any?>) : Mutation()
        data class Delete(val ref: DocumentReference) : Mutation()
    }

    private val operations = mutableListOf<Mutation>()
    private var committed = false

    fun set(documentRef: DocumentReference, data: Any): WriteBatch =
        set(documentRef, data, SetOptions.overwrite())

    @Suppress("UNCHECKED_CAST")
    fun set(documentRef: DocumentReference, data: Any, options: SetOptions): WriteBatch {
        checkNotCommitted()
        val map = when (data) {
            is Map<*, *> -> data as Map<String, Any?>
            else -> throw IllegalArgumentException("Custom object serialization not yet supported in set()")
        }
        SentinelValidator.validateNoDelete(map, options.isMerge)
        operations.add(Mutation.Set(documentRef, map, options))
        return this
    }

    fun update(documentRef: DocumentReference, data: Map<String, Any?>): WriteBatch {
        checkNotCommitted()
        operations.add(Mutation.Update(documentRef, data))
        return this
    }

    fun update(documentRef: DocumentReference, field: String, value: Any?, vararg moreFieldsAndValues: Any?): WriteBatch {
        checkNotCommitted()
        require(moreFieldsAndValues.size % 2 == 0) {
            "Missing value in call to update(). There must be an even number of arguments that alternate between field names and values"
        }
        val map = mutableMapOf<String, Any?>(field to value)
        for (i in moreFieldsAndValues.indices step 2) {
            map[moreFieldsAndValues[i] as String] = moreFieldsAndValues[i + 1]
        }
        return update(documentRef, map)
    }

    fun delete(documentRef: DocumentReference): WriteBatch {
        checkNotCommitted()
        operations.add(Mutation.Delete(documentRef))
        return this
    }

    fun commit(): Task<Void?> {
        checkNotCommitted()
        committed = true
        if (operations.isEmpty()) {
            return Tasks.forResult(null)
        }

        val tcs = TaskCompletionSource<Void?>()
        val writes = operations.map { op ->
            when (op) {
                is Mutation.Set -> mapOf(
                    "op" to "set",
                    "path" to op.ref.path,
                    "data" to ValueCodec.encodeWriteData(op.data),
                    "merge" to op.options.isMerge
                )
                is Mutation.Update -> mapOf(
                    "op" to "update",
                    "path" to op.ref.path,
                    "data" to ValueCodec.encodeWriteData(op.data)
                )
                is Mutation.Delete -> mapOf(
                    "op" to "delete",
                    "path" to op.ref.path
                )
            }
        }

        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                firestore.bridgeClient.op(
                    method = "batchCommit",
                    params = mapOf("writes" to writes),
                    actAs = firestore.getEffectiveAuthLens().toMap()
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }

        return tcs.task
    }

    private fun checkNotCommitted() {
        check(!committed) { "A write batch can no longer be used after commit() has been called." }
    }

    fun interface Function {
        fun apply(batch: WriteBatch)
    }
}
