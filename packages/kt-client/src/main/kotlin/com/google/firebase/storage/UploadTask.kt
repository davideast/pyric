package com.google.firebase.storage

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.net.URI

/**
 * Controllable upload task returned by [StorageReference.putBytes], matching
 * upstream Android `com.google.firebase.storage.UploadTask`.
 */
class UploadTask internal constructor(
    reference: StorageReference,
    private val payload: ByteArray,
    private val initialMetadata: StorageMetadata?
) : StorageTask<UploadTask.TaskSnapshot>(reference) {

    inner class TaskSnapshot internal constructor(
        error: Exception?,
        val bytesTransferred: Long,
        val totalByteCount: Long,
        val metadata: StorageMetadata?,
        val uploadSessionUri: URI? = null
    ) : SnapshotBase(error)

    private val totalBytes: Long = payload.size.toLong()

    @Volatile
    private var latestSnapshot: TaskSnapshot = TaskSnapshot(
        error = null,
        bytesTransferred = 0L,
        totalByteCount = totalBytes,
        metadata = initialMetadata,
        uploadSessionUri = null
    )

    @Volatile
    private var uploadJob: Job? = null

    override val snapshot: TaskSnapshot
        get() = latestSnapshot

    internal fun start(): UploadTask {
        if (targetReference.wirePath.isEmpty()) {
            val rootError = StorageException.fromException(
                IllegalArgumentException("Cannot upload to getRoot. Upload to a child reference instead.")
            )
            latestSnapshot = TaskSnapshot(rootError, 0L, totalBytes, null, null)
            tryCompleteFailure(rootError)
            return this
        }

        val bytesCopy = payload.copyOf()
        uploadJob = targetReference.storage.storageScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val storedMetadata = BridgeStorageOperations.putBytes(
                    reference = targetReference,
                    bytes = bytesCopy,
                    metadata = initialMetadata
                ) { transferred ->
                    val progressSnap = TaskSnapshot(
                        error = null,
                        bytesTransferred = transferred,
                        totalByteCount = totalBytes,
                        metadata = initialMetadata,
                        uploadSessionUri = null
                    )
                    latestSnapshot = progressSnap
                    notifyProgress(progressSnap)
                }
                if (isCanceled()) {
                    return@launch
                }
                val finalSnap = TaskSnapshot(
                    error = null,
                    bytesTransferred = totalBytes,
                    totalByteCount = totalBytes,
                    metadata = storedMetadata,
                    uploadSessionUri = null
                )
                latestSnapshot = finalSnap
                notifyProgress(finalSnap)
                tryCompleteSuccess(finalSnap)
            } catch (_: CancellationException) {
                val cancelErr = StorageException(StorageException.ERROR_CANCELED)
                latestSnapshot = TaskSnapshot(
                    error = cancelErr,
                    bytesTransferred = latestSnapshot.bytesTransferred,
                    totalByteCount = totalBytes,
                    metadata = latestSnapshot.metadata,
                    uploadSessionUri = null
                )
                tryCompleteCanceled(cancelErr)
            } catch (t: Throwable) {
                if (isCanceled()) {
                    return@launch
                }
                val storageError = StorageException.fromWireException(t)
                latestSnapshot = TaskSnapshot(
                    error = storageError,
                    bytesTransferred = latestSnapshot.bytesTransferred,
                    totalByteCount = totalBytes,
                    metadata = latestSnapshot.metadata,
                    uploadSessionUri = null
                )
                tryCompleteFailure(storageError)
            }
        }
        return this
    }

    override fun cancel(): Boolean {
        val cancelError = StorageException(StorageException.ERROR_CANCELED)
        latestSnapshot = TaskSnapshot(
            error = cancelError,
            bytesTransferred = latestSnapshot.bytesTransferred,
            totalByteCount = totalBytes,
            metadata = latestSnapshot.metadata,
            uploadSessionUri = null
        )
        val canceled = tryCompleteCanceled(cancelError)
        if (canceled) {
            uploadJob?.cancel()
        }
        return canceled
    }
}
