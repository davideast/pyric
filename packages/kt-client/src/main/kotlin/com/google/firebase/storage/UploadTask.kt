package com.google.firebase.storage

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.IOException
import java.io.RandomAccessFile
import java.net.URI

/**
 * Controllable, resumable upload task returned by [StorageReference.putBytes],
 * [StorageReference.putStream], and [StorageReference.putFile], matching upstream
 * Android `com.google.firebase.storage.UploadTask`.
 */
class UploadTask internal constructor(
    reference: StorageReference,
    private val source: UploadPayloadSource,
    private val initialMetadata: StorageMetadata?,
    internal val chunkSizeBytes: Int = ChunkedUploadDriver.DEFAULT_UPLOAD_CHUNK_BYTES
) : StorageTask<UploadTask.TaskSnapshot>(reference) {

    internal constructor(
        reference: StorageReference,
        payload: ByteArray,
        initialMetadata: StorageMetadata?
    ) : this(reference, UploadPayloadSource.Bytes(payload.copyOf()), initialMetadata)

    inner class TaskSnapshot internal constructor(
        error: Exception?,
        val bytesTransferred: Long,
        val totalByteCount: Long,
        val metadata: StorageMetadata?,
        val uploadSessionUri: URI? = null
    ) : SnapshotBase(error)

    private val commitTracker = UploadCommitTracker(
        lock = stateLock,
        reference = targetReference,
        scope = targetReference.storage.storageScope
    )

    private var totalBytesKnown: Long = UploadPayloadReader.computeInitialTotalBytes(source)
    private var transferredBytes: Long = 0L
    private var currentMetadata: StorageMetadata? = initialMetadata
    private var currentSessionUri: URI? = UploadPayloadReader.initialExistingUri(source)
    private var stagedUploadId: String? = null
    private var activeChunkSignal: TransferCancelSignal? = null
    private var needsOffsetResync: Boolean = false

    @Volatile
    private var latestSnapshot: TaskSnapshot = buildSnapshotLocked(error = null)

    @Volatile
    private var workerJob: Job? = null

    override val snapshot: TaskSnapshot
        get() = latestSnapshot

    internal fun start(): UploadTask {
        if (targetReference.wirePath.isEmpty()) {
            val err = IllegalArgumentException("Cannot upload to getRoot. Upload to a child reference instead.")
            tryCompleteFailure(StorageException.fromException(err))
            return this
        }
        targetReference.registerActiveUpload(this)
        workerJob = targetReference.storage.storageScope.launch { runUploadLoop() }
        return this
    }

    private suspend fun runUploadLoop() {
        try {
            when (val payloadSource = source) {
                is UploadPayloadSource.Bytes -> executeBytesUpload(payloadSource.data)
                is UploadPayloadSource.Stream -> {
                    val spooled = UploadPayloadReader.spoolStreamInBoundedChunks(
                        stream = payloadSource.inputStream,
                        chunkSizeBytes = chunkSizeBytes,
                        awaitActive = { awaitActiveOrThrowCanceled() }
                    )
                    val total = spooled.sumOf { it.size.toLong() }
                    synchronized(stateLock) {
                        totalBytesKnown = total
                        latestSnapshot = buildSnapshotLocked(error = null)
                    }
                    executeChunkedTransfer(
                        totalBytes = total,
                        inferredContentType = null,
                        existingSessionUri = null,
                        readAllFallbackBytes = { UploadPayloadReader.flattenSegments(spooled, total.toInt()) },
                        readChunkAt = { off, len -> UploadPayloadReader.sliceFromSegments(spooled, off, len) }
                    )
                }
                is UploadPayloadSource.LocalFile -> {
                    val opened = UploadPayloadReader.openValidatedLocalFile(payloadSource.uri)
                    synchronized(stateLock) {
                        totalBytesKnown = opened.totalBytes
                        latestSnapshot = buildSnapshotLocked(error = null)
                    }
                    RandomAccessFile(opened.file, "r").use { raf ->
                        executeChunkedTransfer(
                            totalBytes = opened.totalBytes,
                            inferredContentType = opened.inferredContentType,
                            existingSessionUri = payloadSource.existingUploadUri,
                            readAllFallbackBytes = { UploadPayloadReader.readFileRange(raf, 0L, opened.totalBytes.toInt()) },
                            readChunkAt = { off, len -> UploadPayloadReader.readFileRange(raf, off, len) }
                        )
                    }
                }
            }
        } catch (_: CancellationException) {
            // Pause/cancel transitions manage state directly.
        } catch (t: Throwable) {
            if (!isCanceled()) tryCompleteFailure(StorageException.fromWireException(t))
        }
    }

    private suspend fun executeBytesUpload(data: ByteArray) {
        val total = data.size.toLong()
        if (total > BridgeStorageOperations.MAX_STORAGE_OBJECT_BYTES) {
            throw StorageException(StorageException.ERROR_QUOTA_EXCEEDED)
        }
        val client = targetReference.storage.bridgeClient
        val prefersSingleFrame = total <= chunkSizeBytes.toLong() &&
            !StorageByteRouteClient.isHttpByteRouteKnown(client)
        if (prefersSingleFrame) {
            notifyProgressIfActive(latestSnapshot)
            awaitActiveOrThrowCanceled()
            val outcome = commitTracker.runCommit(onClearStagedIdLocked = { stagedUploadId = null }) {
                ChunkedUploadDriver.singleFrameUploadWithRollback(
                    reference = targetReference,
                    bytes = data,
                    contentType = initialMetadata?.contentType?.takeIf { it.isNotEmpty() },
                    metadata = initialMetadata
                )
            }
            val failure = outcome.exceptionOrNull()
            val cause = failure?.cause ?: failure
            if (cause != null && StorageByteRouteClient.isByteRouteRefusal(cause)) {
                commitTracker.clearInFlight()
                StorageByteRouteClient.markHttpByteRoute(client)
            } else {
                settleCommitOutcome(outcome, total)
                return
            }
        }

        val segments = UploadPayloadReader.sliceIntoSegments(data, chunkSizeBytes)
        executeChunkedTransfer(
            totalBytes = total,
            inferredContentType = null,
            existingSessionUri = null,
            readAllFallbackBytes = { data },
            readChunkAt = { off, len -> UploadPayloadReader.sliceFromSegments(segments, off, len) }
        )
    }

    private suspend fun executeChunkedTransfer(
        totalBytes: Long,
        inferredContentType: String?,
        existingSessionUri: URI?,
        readAllFallbackBytes: () -> ByteArray,
        readChunkAt: (offset: Long, length: Int) -> ByteArray
    ) {
        awaitActiveOrThrowCanceled()
        val effectiveType = initialMetadata?.contentType?.takeIf { it.isNotEmpty() } ?: inferredContentType
        val session: StagedUploadSession = try {
            if (existingSessionUri != null) {
                ChunkedUploadDriver.restoreSessionFromUri(targetReference, existingSessionUri)
            } else {
                ChunkedUploadDriver.beginSession(targetReference, totalBytes, effectiveType, initialMetadata)
            }
        } catch (t: Throwable) {
            if (existingSessionUri == null &&
                totalBytes <= BridgeStorageOperations.MAX_STORAGE_PART_BYTES &&
                ChunkedUploadDriver.isUnsupportedChunkedOp(t)
            ) {
                notifyProgressIfActive(latestSnapshot)
                awaitActiveOrThrowCanceled()
                val outcome = commitTracker.runCommit(onClearStagedIdLocked = { stagedUploadId = null }) {
                    ChunkedUploadDriver.singleFrameUploadWithRollback(
                        targetReference, readAllFallbackBytes(), effectiveType, initialMetadata
                    )
                }
                settleCommitOutcome(outcome, totalBytes)
                return
            }
            throw StorageException.fromWireException(t)
        }

        val abortedImmediately = synchronized(stateLock) {
            val st = currentInternalState()
            val canceled = st == StorageTaskInternalState.CANCELING || st == StorageTaskInternalState.CANCELED
            if (!canceled) {
                stagedUploadId = session.uploadId
                currentSessionUri = session.sessionUri
                latestSnapshot = buildSnapshotLocked(error = null)
            }
            canceled
        }
        if (abortedImmediately) {
            ChunkedUploadDriver.abortSession(targetReference, session.uploadId)
            return
        }

        var offset = if (existingSessionUri != null) {
            probeOffsetPausedAware(session, totalBytes).also { updateProgressSnapshot(it) }
        } else {
            notifyProgressIfActive(latestSnapshot)
            0L
        }

        try {
            while (offset < totalBytes) {
                awaitActiveOrThrowCanceled()
                val shouldResync = synchronized(stateLock) {
                    val flag = needsOffsetResync
                    needsOffsetResync = false
                    flag
                }
                if (shouldResync) {
                    offset = probeOffsetPausedAware(session, totalBytes)
                    updateProgressSnapshot(offset)
                    if (offset >= totalBytes) break
                }

                val chunkLen = minOf(chunkSizeBytes.toLong(), totalBytes - offset).toInt()
                val partIndex = (offset / chunkSizeBytes.toLong()).toInt()
                val chunkBytes = readChunkAt(offset, chunkLen)
                val signal = newActiveChunkSignal()
                val nextOffset = try {
                    ChunkedUploadDriver.sendChunk(
                        targetReference, session, partIndex, offset, totalBytes, chunkBytes, chunkLen, signal
                    )
                } catch (err: Exception) {
                    if ((err is IOException || err is StorageException) &&
                        (signal.isAborted || isPaused() || isCanceled())
                    ) continue
                    throw err
                } finally {
                    clearActiveChunkSignal(signal)
                }
                offset = nextOffset
                updateProgressSnapshot(offset)
            }

            awaitActiveOrThrowCanceled()
            val commitOutcome = commitTracker.runCommit(onClearStagedIdLocked = { stagedUploadId = null }) {
                ChunkedUploadDriver.finishSession(targetReference, session, requestRollback = true)
            }
            settleCommitOutcome(commitOutcome, totalBytes)
        } catch (t: Throwable) {
            if (!isPaused() && !isCanceled()) ChunkedUploadDriver.abortSession(targetReference, session.uploadId)
            throw t
        }
    }

    private suspend fun probeOffsetPausedAware(session: StagedUploadSession, totalBytes: Long): Long {
        while (true) {
            awaitActiveOrThrowCanceled()
            val signal = newActiveChunkSignal()
            try {
                return ChunkedUploadDriver.queryReceivedOffset(targetReference, session, totalBytes, signal)
            } catch (ioErr: IOException) {
                if (signal.isAborted || isPaused() || isCanceled()) continue
                throw ioErr
            } finally {
                clearActiveChunkSignal(signal)
            }
        }
    }

    private fun settleCommitOutcome(outcome: Result<CommittedUploadReceipt>, totalBytes: Long) {
        val held = synchronized(stateLock) {
            commitTracker.holdIfPausedLocked(currentInternalState(), outcome)
        }
        if (held || isCanceled()) return

        outcome.fold(
            onSuccess = { receipt ->
                val finalSnap = synchronized(stateLock) {
                    transferredBytes = totalBytes
                    totalBytesKnown = totalBytes
                    currentMetadata = receipt.metadata
                    buildSnapshotLocked(error = null).also { latestSnapshot = it }
                }
                tryCompleteSuccess(finalSnap)
            },
            onFailure = { err ->
                tryCompleteFailure(StorageException.fromWireException(err))
            }
        )
    }

    private fun updateProgressSnapshot(newOffset: Long) {
        val snap = synchronized(stateLock) {
            transferredBytes = newOffset
            buildSnapshotLocked(error = null).also { latestSnapshot = it }
        }
        notifyProgressIfActive(snap)
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
        if (abortNow) signal.abort()
        return signal
    }

    private fun clearActiveChunkSignal(signal: TransferCancelSignal) {
        synchronized(stateLock) {
            if (activeChunkSignal === signal) activeChunkSignal = null
        }
    }

    override fun onPausedTransitionLocked() {
        needsOffsetResync = true
        activeChunkSignal?.abort()
        activeChunkSignal = null
        latestSnapshot = buildSnapshotLocked(error = null)
    }

    override fun onResumedTransitionLocked() {
        latestSnapshot = buildSnapshotLocked(error = null)
    }

    override fun onResumedPostUnlock() {
        val held = commitTracker.takeHeldPausedOutcome()
        if (held != null) {
            settleCommitOutcome(held, totalBytesKnown.coerceAtLeast(0L))
        } else {
            notifyProgressIfActive(latestSnapshot)
        }
    }

    override fun onCanceledTransitionLocked(cancelError: StorageException) {
        activeChunkSignal?.abort()
        activeChunkSignal = null
        latestSnapshot = buildSnapshotLocked(error = cancelError)
    }

    override fun tryDeferCancelForRollbackLocked(cancelError: StorageException): (() -> Unit)? {
        val deferred = commitTracker.prepareDeferredCancelRollbackLocked(stagedUploadId)
        if (deferred != null) {
            stagedUploadId = null
            return {
                (source as? UploadPayloadSource.Stream)?.inputStream?.let { runCatching { it.close() } }
                deferred()
            }
        }
        return null
    }

    override fun onCanceledCleanup() {
        val uploadId = synchronized(stateLock) { stagedUploadId.also { stagedUploadId = null } }
        (source as? UploadPayloadSource.Stream)?.inputStream?.let { runCatching { it.close() } }
        workerJob?.cancel()
        if (uploadId != null) {
            targetReference.storage.storageScope.launch {
                ChunkedUploadDriver.abortSession(targetReference, uploadId)
            }
        }
    }

    override fun onSuccessTransitionLocked(finalSnapshot: TaskSnapshot) { latestSnapshot = finalSnapshot }
    override fun onFailureTransitionLocked(error: StorageException) { latestSnapshot = buildSnapshotLocked(error) }
    override fun onTaskDeactivated() { targetReference.unregisterActiveUpload(this) }

    private fun buildSnapshotLocked(error: Exception?): TaskSnapshot =
        TaskSnapshot(error ?: exception, transferredBytes, totalBytesKnown, currentMetadata, currentSessionUri)
}
