package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch

class DocumentReference internal constructor(
    val firestore: FirebaseFirestore,
    val path: String
) {
    val id: String get() = path.substringAfterLast('/')

    val parent: CollectionReference
        get() {
            val parentPath = if (path.contains('/')) path.substringBeforeLast('/') else ""
            return firestore.collection(parentPath)
        }

    fun collection(collectionPath: String): CollectionReference {
        val trimmed = collectionPath.trim('/')
        return firestore.collection("$path/$trimmed")
    }

    fun get(source: Source = Source.DEFAULT): Task<DocumentSnapshot> {
        val tcs = TaskCompletionSource<DocumentSnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                val res = firestore.bridgeClient.op(
                    method = "getDoc",
                    params = mapOf("path" to path)
                )
                @Suppress("UNCHECKED_CAST")
                val resMap = res as? Map<String, Any?> ?: emptyMap()
                val docId = (resMap["id"] as? String) ?: id
                val docPath = (resMap["path"] as? String) ?: path
                val exists = resMap["exists"] == true
                val rawData = resMap["data"]
                val unpackedData = if (exists) {
                    DocumentDataEnvelope.unpack(rawData) { p -> firestore.document(p) }
                } else null

                val snapshot = DocumentSnapshot(
                    id = docId,
                    reference = this@DocumentReference,
                    exists = exists,
                    rawData = unpackedData,
                    metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                )
                tcs.setResult(snapshot)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun set(data: Any): Task<Void?> = set(data, SetOptions.overwrite())

    @Suppress("UNCHECKED_CAST")
    fun set(data: Any, options: SetOptions): Task<Void?> {
        val map = when (data) {
            is Map<*, *> -> data as Map<String, Any?>
            else -> throw IllegalArgumentException("Custom object serialization not yet supported in set()")
        }

        // Validate delete sentinels
        SentinelValidator.validateNoDelete(map, options.isMerge)

        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                firestore.bridgeClient.op(
                    method = "setDoc",
                    params = mapOf(
                        "path" to path,
                        "data" to ValueCodec.encodeWriteData(map),
                        "merge" to options.isMerge
                    )
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun update(data: Map<String, Any?>): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                firestore.bridgeClient.op(
                    method = "updateDoc",
                    params = mapOf(
                        "path" to path,
                        "data" to ValueCodec.encodeWriteData(data)
                    )
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun update(field: String, value: Any?, vararg moreFieldsAndValues: Any?): Task<Void?> {
        require(moreFieldsAndValues.size % 2 == 0) {
            "Missing value in call to update(). There must be an even number of arguments that alternate between field names and values"
        }
        val map = mutableMapOf<String, Any?>(field to value)
        for (i in moreFieldsAndValues.indices step 2) {
            map[moreFieldsAndValues[i] as String] = moreFieldsAndValues[i + 1]
        }
        return update(map)
    }

    fun delete(): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            try {
                firestore.bridgeClient.op(
                    method = "deleteDoc",
                    params = mapOf("path" to path)
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun addSnapshotListener(
        metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE,
        listener: EventListener<DocumentSnapshot>
    ): ListenerRegistration {
        val scope = CoroutineScope(Dispatchers.IO)
        val flow = firestore.bridgeClient.subscribe(
            target = mapOf("__ref" to "doc", "path" to path),
            includeMetadataChanges = (metadataChanges == MetadataChanges.INCLUDE)
        )

        var job: Job? = null
        job = scope.launch {
            flow.catch { e ->
                val fse = (e as? FirebaseFirestoreException)
                    ?: FirebaseFirestoreException(e.message ?: "Snapshot error", FirebaseFirestoreException.Code.UNKNOWN, e)
                listener.onEvent(null, fse)
            }.collect { rawMsg ->
                @Suppress("UNCHECKED_CAST")
                val resMap = rawMsg as? Map<String, Any?> ?: emptyMap()
                val docId = (resMap["id"] as? String) ?: id
                val docPath = (resMap["path"] as? String) ?: path
                val exists = resMap["exists"] == true
                val rawData = resMap["data"]
                val unpackedData = if (exists) {
                    DocumentDataEnvelope.unpack(rawData) { p -> firestore.document(p) }
                } else null

                val snapshot = DocumentSnapshot(
                    id = docId,
                    reference = this@DocumentReference,
                    exists = exists,
                    rawData = unpackedData,
                    metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
                )
                listener.onEvent(snapshot, null)
            }
        }

        return ListenerRegistration { job.cancel() }
    }


    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DocumentReference) return false
        return path == other.path && firestore == other.firestore
    }

    override fun hashCode(): Int {
        var result = firestore.hashCode()
        result = 31 * result + path.hashCode()
        return result
    }

    override fun toString(): String = "DocumentReference(path=$path)"
}
