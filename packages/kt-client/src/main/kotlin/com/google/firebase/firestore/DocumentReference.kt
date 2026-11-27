package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.PojoCodec
import dev.pyric.codecs.SentinelValidator
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
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
        require(trimmed.isNotEmpty()) {
            "Invalid collection reference. Collection path must not be empty."
        }
        return firestore.collection("$path/$trimmed")
    }

    fun get(source: Source = Source.DEFAULT): Task<DocumentSnapshot> {
        firestore.ensureClientActive()
        if (source == Source.CACHE) {
            return getFromCacheTask(
                "Failed to get document from cache. (However, this document may exist on the server. " +
                    "Run again without setting source to CACHE to attempt to retrieve the document from the server.)"
            )
        }
        if (!firestore.offlineCoordinator.isNetworkEnabled) {
            if (source == Source.SERVER) {
                return Tasks.forException(
                    FirebaseFirestoreException(
                        "Failed to get document because the client is offline.",
                        FirebaseFirestoreException.Code.UNAVAILABLE
                    )
                )
            }
            return getFromCacheTask("Failed to get document because the client is offline.")
        }

        val tcs = TaskCompletionSource<DocumentSnapshot>()
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val requestLens = firestore.getEffectiveAuthLens()
                val requestScope = FirestoreOfflineCoordinator.authScopeForLens(requestLens)
                val res = firestore.bridgeClient.op(
                    method = "getDoc",
                    params = mapOf("path" to path),
                    actAs = requestLens.toMap()
                )
                @Suppress("UNCHECKED_CAST")
                val resMap = res as? Map<String, Any?> ?: emptyMap()
                val docId = (resMap["id"] as? String) ?: id
                val exists = resMap["exists"] == true
                val rawData = resMap["data"]
                val unpackedData = if (exists) {
                    DocumentDataEnvelope.unpack(rawData) { p -> firestore.unvalidatedDocumentRef(p) }
                } else null
                val rawEnvelope = if (exists) DocumentDataEnvelope.extractEnvelope(rawData) else null
                firestore.offlineCoordinator.recordServerDoc(path, exists, unpackedData, rawEnvelope, requestScope)

                val projected = firestore.offlineCoordinator.projectDocument(path, requestScope)
                val finalExists = if (projected.hasPendingWrites) projected.exists else exists
                val finalData = if (projected.hasPendingWrites) projected.data else unpackedData
                val snapshot = DocumentSnapshot(
                    id = docId,
                    reference = this@DocumentReference,
                    exists = finalExists,
                    rawData = finalData,
                    metadata = SnapshotMetadata(
                        hasPendingWrites = projected.hasPendingWrites,
                        isFromCache = false
                    ),
                    rawWireData = if (finalExists && !projected.hasPendingWrites) rawEnvelope else null
                )
                tcs.setResult(snapshot)
            } catch (e: Exception) {
                val fse = e as? FirebaseFirestoreException
                if (source == Source.DEFAULT && fse?.code == FirebaseFirestoreException.Code.UNAVAILABLE) {
                    val cached = firestore.offlineCoordinator.projectDocument(path)
                    if (cached.known) {
                        tcs.setResult(snapshotFromProjection(cached, isFromCache = true))
                        return@launch
                    }
                }
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    private fun getFromCacheTask(missMessage: String): Task<DocumentSnapshot> {
        val projected = firestore.offlineCoordinator.projectDocument(path)
        if (!projected.known) {
            return Tasks.forException(
                FirebaseFirestoreException(missMessage, FirebaseFirestoreException.Code.UNAVAILABLE)
            )
        }
        return Tasks.forResult(snapshotFromProjection(projected, isFromCache = true))
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

        val encodedData = ValueCodec.encodeWriteData(map)
        val wireOptions = options.toWireOptions()
        val mutation = if (options.isMerge) {
            OfflineDocMutation.SetMerge(path, map, options.mergeFields)
        } else {
            OfflineDocMutation.SetOverwrite(path, map)
        }

        return firestore.offlineCoordinator.submitWrite(mutation) {
            val params = mutableMapOf<String, Any?>(
                "path" to path,
                "data" to encodedData
            )
            if (wireOptions != null) {
                params["options"] = wireOptions
            }
            firestore.bridgeClient.op(
                method = "setDoc",
                params = params,
                actAs = firestore.getEffectiveAuthLens().toMap()
            )
        }
    }

    fun update(data: Map<String, Any?>): Task<Void?> {
        firestore.ensureClientActive()
        SentinelValidator.validateNoNestedArraySentinels(data)
        val encodedData = ValueCodec.encodeWriteData(data)
        val mutation = OfflineDocMutation.UpdateMap(path, data)
        return firestore.offlineCoordinator.submitWrite(mutation) {
            firestore.bridgeClient.op(
                method = "updateDoc",
                params = mapOf(
                    "path" to path,
                    "data" to encodedData
                ),
                actAs = firestore.getEffectiveAuthLens().toMap()
            )
        }
    }

    fun update(field: String, value: Any?, vararg moreFieldsAndValues: Any?): Task<Void?> {
        require(moreFieldsAndValues.size % 2 == 0) {
            "Missing value in call to update(). There must be an even number of arguments that alternate between field names and values"
        }
        val hasFieldPathArg = (moreFieldsAndValues.indices step 2).any { moreFieldsAndValues[it] is FieldPath }
        if (hasFieldPathArg) {
            return update(FieldPath.fromDotSeparated(field), value, *moreFieldsAndValues)
        }
        val map = mutableMapOf<String, Any?>(field to value)
        for (i in moreFieldsAndValues.indices step 2) {
            val key = moreFieldsAndValues[i] as? String
                ?: throw IllegalArgumentException("Expected String or FieldPath key at argument index ${i + 2} in update().")
            map[key] = moreFieldsAndValues[i + 1]
        }
        return update(map)
    }

    fun update(fieldPath: FieldPath, value: Any?, vararg moreFieldsAndValues: Any?): Task<Void?> {
        firestore.ensureClientActive()
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
        for ((_, fieldVal) in entries) {
            SentinelValidator.validateNoNestedArraySentinels(fieldVal)
        }
        val encodedFields = entries.map { (fp, fieldVal) ->
            mapOf(
                "path" to fp.segments,
                "value" to ValueCodec.encodeValue(fieldVal)
            )
        }
        val mutation = OfflineDocMutation.UpdateFields(path, entries)
        return firestore.offlineCoordinator.submitWrite(mutation) {
            firestore.bridgeClient.op(
                method = "updateDoc",
                params = mapOf(
                    "path" to path,
                    "fields" to encodedFields
                ),
                actAs = firestore.getEffectiveAuthLens().toMap()
            )
        }
    }

    fun delete(): Task<Void?> {
        firestore.ensureClientActive()
        val mutation = OfflineDocMutation.Delete(path)
        return firestore.offlineCoordinator.submitWrite(mutation) {
            firestore.bridgeClient.op(
                method = "deleteDoc",
                params = mapOf("path" to path),
                actAs = firestore.getEffectiveAuthLens().toMap()
            )
        }
    }

    fun snapshots(metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE): Flow<DocumentSnapshot> {
        firestore.ensureClientActive()
        return DocumentSnapshotRegistration.snapshotsFlow(this, metadataChanges == MetadataChanges.INCLUDE)
    }

    internal fun snapshotFromProjection(projected: ProjectedDocState, isFromCache: Boolean): DocumentSnapshot {
        return DocumentSnapshot(
            id = id,
            reference = this,
            exists = projected.exists,
            rawData = if (projected.exists) projected.data else null,
            metadata = SnapshotMetadata(
                hasPendingWrites = projected.hasPendingWrites,
                isFromCache = isFromCache
            ),
            rawWireData = if (projected.exists && !projected.hasPendingWrites) projected.rawWireData else null
        )
    }

    internal fun snapshotFromWireAndCache(
        rawMsg: Any?,
        authScope: String = firestore.offlineCoordinator.currentAuthScope()
    ): DocumentSnapshot {
        @Suppress("UNCHECKED_CAST")
        val resMap = rawMsg as? Map<String, Any?> ?: emptyMap()
        val docId = (resMap["id"] as? String) ?: id
        val exists = resMap["exists"] == true
        val rawData = resMap["data"]
        val unpackedData = if (exists) {
            DocumentDataEnvelope.unpack(rawData) { p -> firestore.unvalidatedDocumentRef(p) }
        } else null
        val rawEnvelope = if (exists) DocumentDataEnvelope.extractEnvelope(rawData) else null
        firestore.offlineCoordinator.recordServerDoc(path, exists, unpackedData, rawEnvelope, authScope)

        val projected = firestore.offlineCoordinator.projectDocument(path, authScope)
        val hasPending = projected.hasPendingWrites || resMap["hasPendingWrites"] == true
        val finalExists = if (projected.hasPendingWrites) projected.exists else exists
        val finalData = if (projected.hasPendingWrites) projected.data else unpackedData

        return DocumentSnapshot(
            id = docId,
            reference = this,
            exists = finalExists,
            rawData = finalData,
            metadata = SnapshotMetadata(hasPendingWrites = hasPending, isFromCache = false),
            rawWireData = if (finalExists && !projected.hasPendingWrites) rawEnvelope else null
        )
    }

    internal fun snapshotFromWire(rawMsg: Any?, isFromCache: Boolean): DocumentSnapshot {
        @Suppress("UNCHECKED_CAST")
        val resMap = rawMsg as? Map<String, Any?> ?: emptyMap()
        val docId = (resMap["id"] as? String) ?: id
        val exists = resMap["exists"] == true
        val rawData = resMap["data"]
        val unpackedData = if (exists) {
            DocumentDataEnvelope.unpack(rawData) { p -> firestore.unvalidatedDocumentRef(p) }
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
        return DocumentSnapshotRegistration(
            docRef = this,
            includeMetadata = (metadataChanges == MetadataChanges.INCLUDE),
            onSnapshot = { snapshot -> listener.onEvent(snapshot, null) },
            onError = { error -> listener.onEvent(null, error) }
        )
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
