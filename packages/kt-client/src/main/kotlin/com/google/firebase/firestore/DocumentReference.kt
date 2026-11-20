package com.google.firebase.firestore

import dev.pyric.codecs.PojoCodec
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.bridge.BridgeSubscriptionGap
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.takeWhile
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
        firestore.ensureClientActive()
        val tcs = TaskCompletionSource<DocumentSnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val res = firestore.bridgeClient.op(
                    method = "getDoc",
                    params = mapOf("path" to path),
                    actAs = firestore.getEffectiveAuthLens().toMap()
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
                    metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false),
                    rawWireData = if (exists) DocumentDataEnvelope.extractEnvelope(rawData) else null
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
        firestore.ensureClientActive()
        val map = when (data) {
            is Map<*, *> -> data as Map<String, Any?>
            else -> PojoCodec.serialize(data)
        }

        // Validate sentinels synchronously
        SentinelValidator.validateNoDelete(map, options.isMerge)
        SentinelValidator.validateNoNestedArraySentinels(map)

        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        // Undispatched, so the frame is sent or held on the caller's thread and
        // back-to-back writes reach the host in call order (#1032).
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val params = mutableMapOf<String, Any?>(
                    "path" to path,
                    "data" to ValueCodec.encodeWriteData(map)
                )
                val wireOptions = options.toWireOptions()
                if (wireOptions != null) {
                    params["options"] = wireOptions
                }
                firestore.bridgeClient.op(
                    method = "setDoc",
                    params = params,
                    actAs = firestore.getEffectiveAuthLens().toMap()
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun update(data: Map<String, Any?>): Task<Void?> {
        firestore.ensureClientActive()
        SentinelValidator.validateNoNestedArraySentinels(data)
        val encodedData = ValueCodec.encodeWriteData(data)
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        // Undispatched, so the frame is sent or held on the caller's thread and
        // back-to-back writes reach the host in call order (#1032).
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                firestore.bridgeClient.op(
                    method = "updateDoc",
                    params = mapOf(
                        "path" to path,
                        "data" to encodedData
                    ),
                    actAs = firestore.getEffectiveAuthLens().toMap()
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
        firestore.ensureClientActive()
        val tcs = TaskCompletionSource<Void?>()
        val scope = CoroutineScope(Dispatchers.IO)
        // Undispatched, so the frame is sent or held on the caller's thread and
        // back-to-back writes reach the host in call order (#1032).
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                firestore.bridgeClient.op(
                    method = "deleteDoc",
                    params = mapOf("path" to path),
                    actAs = firestore.getEffectiveAuthLens().toMap()
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    fun snapshots(metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE): Flow<DocumentSnapshot> {
        firestore.ensureClientActive()
        val target = mapOf("__ref" to "doc", "path" to path)
        val includeMetadata = (metadataChanges == MetadataChanges.INCLUDE)
        return combine(firestore.authLensFlow, firestore.terminatedStateFlow) { lens, terminated ->
            lens to terminated
        }.flatMapLatest { (lens, terminated) ->
            if (terminated) {
                flowOf<DocumentSnapshot?>(null)
            } else {
                var lastRaw: Any? = null
                var hasRaw = false
                firestore.bridgeClient.subscribe(
                    target = target,
                    actAs = lens.toMap(),
                    includeMetadataChanges = includeMetadata
                ).mapNotNull { rawMsg ->
                    if (rawMsg === BridgeSubscriptionGap) {
                        // The document last delivered, now served from cache.
                        if (hasRaw) snapshotFromWire(lastRaw, isFromCache = true) else null
                    } else {
                        lastRaw = rawMsg
                        hasRaw = true
                        snapshotFromWire(rawMsg, isFromCache = false)
                    }
                }
            }
        }.takeWhile { it != null }.mapNotNull { it }
    }

    private fun snapshotFromWire(rawMsg: Any?, isFromCache: Boolean): DocumentSnapshot {
        @Suppress("UNCHECKED_CAST")
        val resMap = rawMsg as? Map<String, Any?> ?: emptyMap()
        val docId = (resMap["id"] as? String) ?: id
        val exists = resMap["exists"] == true
        val rawData = resMap["data"]
        val unpackedData = if (exists) {
            DocumentDataEnvelope.unpack(rawData) { p -> firestore.document(p) }
        } else null

        return DocumentSnapshot(
            id = docId,
            reference = this,
            exists = exists,
            rawData = unpackedData,
            metadata = SnapshotMetadata(hasPendingWrites = resMap["hasPendingWrites"] == true, isFromCache = isFromCache),
            rawWireData = if (exists) DocumentDataEnvelope.extractEnvelope(rawData) else null
        )
    }

    fun addSnapshotListener(listener: EventListener<DocumentSnapshot>): ListenerRegistration =
        addSnapshotListener(MetadataChanges.EXCLUDE, listener)

    fun addSnapshotListener(
        metadataChanges: MetadataChanges,
        listener: EventListener<DocumentSnapshot>
    ): ListenerRegistration {
        firestore.ensureClientActive()
        val job = firestore.listenerScope.launch {
            snapshots(metadataChanges).catch { e ->
                val fse = (e as? FirebaseFirestoreException)
                    ?: FirebaseFirestoreException(e.message ?: "Snapshot error", FirebaseFirestoreException.Code.UNKNOWN, e)
                listener.onEvent(null, fse)
            }.collect { snapshot ->
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
