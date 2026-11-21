package com.google.firebase.storage

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URI

/**
 * Controllable file download task returned by [StorageReference.getFile], matching
 * upstream Android `com.google.firebase.storage.FileDownloadTask`.
 */
class FileDownloadTask internal constructor(
    reference: StorageReference,
    private val destinationUri: URI,
    internal val chunkSizeBytes: Int = ChunkedDownloadDriver.DEFAULT_DOWNLOAD_CHUNK_BYTES
) : StorageTask<FileDownloadTask.TaskSnapshot>(reference) {

    inner class TaskSnapshot internal constructor(
        error: Exception?,
        val bytesTransferred: Long,
        val totalByteCount: Long
    ) : SnapshotBase(error)

    private var totalBytesKnown: Long = -1L
    private var transferredBytes: Long = 0L
    private var activeChunkSignal: TransferCancelSignal? = null

    @Volatile
    private var latestSnapshot: TaskSnapshot = TaskSnapshot(
        error = null,
        bytesTransferred = 0L,
        totalByteCount = -1L
    )

    @Volatile
    private var workerJob: Job? = null

    override val snapshot: TaskSnapshot
        get() = latestSnapshot

    internal fun start(): FileDownloadTask {
        if (targetReference.wirePath.isEmpty()) {
            val rootError = StorageException.fromException(
                IllegalArgumentException("Cannot download from getRoot. Download from a child reference instead.")
            )
            tryCompleteFailure(rootError)
            return this
        }
        targetReference.registerActiveDownload(this)
        workerJob = targetReference.storage.storageScope.launch {
            runDownloadLoop()
        }
        return this
    }

    private suspend fun runDownloadLoop() {
        try {
            val destinationFile = UploadPayloadReader.resolveLocalFile(destinationUri)
            if (destinationFile.exists() && destinationFile.isDirectory) {
                throw StorageException.fromException(
                    FileNotFoundException("Destination path is an existing directory: ${destinationFile.path}")
                )
            }

            awaitActiveOrThrowCanceled()
            val head = ChunkedDownloadDriver.fetchHead(targetReference)
            val totalBytes = head.totalBytes
            val initialSnap = synchronized(stateLock) {
                totalBytesKnown = totalBytes
                buildSnapshotLocked(error = null).also { latestSnapshot = it }
            }
            notifyProgressIfActive(initialSnap)

            val parentDir = destinationFile.parentFile
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs()
            }

            RandomAccessFile(destinationFile, "rw").use { raf ->
                raf.setLength(0L)
            }

            var offset = 0L
            while (offset < totalBytes) {
                awaitActiveOrThrowCanceled()
                val chunkLen = minOf(chunkSizeBytes.toLong(), totalBytes - offset).toInt()
                val signal = newActiveChunkSignal()
                val bytes = try {
                    ChunkedDownloadDriver.readChunk(
                        reference = targetReference,
                        head = head,
                        offset = offset,
                        length = chunkLen,
                        cancelSignal = signal
                    )
                } catch (ioErr: IOException) {
                    if (signal.isAborted || isPaused() || isCanceled()) {
                        continue
                    }
                    throw ioErr
                } catch (stErr: StorageException) {
                    if (signal.isAborted || isPaused() || isCanceled()) {
                        continue
                    }
                    throw stErr
                } finally {
                    clearActiveChunkSignal(signal)
                }

                if (bytes.isEmpty()) {
                    throw StorageException(
                        StorageException.ERROR_UNKNOWN,
                        "Unexpected end of stream at byte $offset/$totalBytes for '${targetReference.wirePath}'."
                    )
                }

                awaitActiveOrThrowCanceled()
                RandomAccessFile(destinationFile, "rw").use { raf ->
                    raf.seek(offset)
                    raf.write(bytes)
                }
                offset += bytes.size.toLong()
                val progressSnap = synchronized(stateLock) {
                    transferredBytes = offset
                    buildSnapshotLocked(error = null).also { latestSnapshot = it }
                }
                notifyProgressIfActive(progressSnap)
            }

            awaitActiveOrThrowCanceled()
            val finalSnap = synchronized(stateLock) {
                transferredBytes = totalBytes
                totalBytesKnown = totalBytes
                buildSnapshotLocked(error = null).also { latestSnapshot = it }
            }
            tryCompleteSuccess(finalSnap)
        } catch (_: CancellationException) {
            // Pause/cancel state transitions manage terminal listeners directly.
        } catch (t: Throwable) {
            if (!isCanceled()) {
                tryCompleteFailure(StorageException.fromWireException(t))
            }
        }
    }

    private fun newActiveChunkSignal(): TransferCancelSignal {
        val signal = TransferCancelSignal()
        val abortNow = synchronized(stateLock) {
            if (currentInternalState() != StorageTaskInternalState.IN_PROGRESS) {
                true
            } else {
                activeChunkSignal = signal
                false
            }
        }
        if (abortNow) {
            signal.abort()
        }
        return signal
    }

    private fun clearActiveChunkSignal(signal: TransferCancelSignal) {
        synchronized(stateLock) {
            if (activeChunkSignal === signal) {
                activeChunkSignal = null
            }
        }
    }

    override fun onPausedTransitionLocked() {
        activeChunkSignal?.abort()
        activeChunkSignal = null
        latestSnapshot = buildSnapshotLocked(error = null)
    }

    override fun onResumedTransitionLocked() {
        latestSnapshot = buildSnapshotLocked(error = null)
    }

    override fun onResumedPostUnlock() {
        notifyProgressIfActive(latestSnapshot)
    }

    override fun onCanceledTransitionLocked(cancelError: StorageException) {
        activeChunkSignal?.abort()
        activeChunkSignal = null
        latestSnapshot = buildSnapshotLocked(error = cancelError)
    }

    override fun onCanceledCleanup() {
        workerJob?.cancel()
    }

    override fun onSuccessTransitionLocked(finalSnapshot: TaskSnapshot) {
        latestSnapshot = finalSnapshot
    }

    override fun onFailureTransitionLocked(error: StorageException) {
        latestSnapshot = buildSnapshotLocked(error = error)
    }

    override fun onTaskDeactivated() {
        targetReference.unregisterActiveDownload(this)
    }

    private fun buildSnapshotLocked(error: Exception?): TaskSnapshot =
        TaskSnapshot(
            error = error ?: exception,
            bytesTransferred = transferredBytes,
            totalByteCount = totalBytesKnown
        )
}
