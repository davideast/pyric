package com.google.firebase.storage

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * Streaming download task returned by [StorageReference.getStream], matching
 * upstream Android `com.google.firebase.storage.StreamDownloadTask`.
 */
class StreamDownloadTask internal constructor(
    reference: StorageReference,
    private val processor: StreamProcessor?,
    internal val chunkSizeBytes: Int = ChunkedDownloadDriver.DEFAULT_DOWNLOAD_CHUNK_BYTES
) : StorageTask<StreamDownloadTask.TaskSnapshot>(reference) {

    fun interface StreamProcessor {
        @Throws(IOException::class)
        fun doInBackground(state: TaskSnapshot, stream: InputStream)
    }

    inner class TaskSnapshot internal constructor(
        error: Exception?,
        val bytesTransferred: Long,
        val totalByteCount: Long,
        val stream: InputStream
    ) : SnapshotBase(error)

    private var totalBytesKnown: Long = -1L
    private var transferredBytes: Long = 0L
    private var activeStream: RangedStorageInputStream? = null
    private val placeholderStream: InputStream = ByteArrayInputStream(ByteArray(0))

    @Volatile
    private var latestSnapshot: TaskSnapshot = TaskSnapshot(
        error = null,
        bytesTransferred = 0L,
        totalByteCount = -1L,
        stream = placeholderStream
    )

    @Volatile
    private var workerJob: Job? = null

    override val snapshot: TaskSnapshot
        get() = latestSnapshot

    override fun pause(): Boolean {
        throw UnsupportedOperationException("this operation is not supported on StreamDownloadTask.")
    }

    override fun resume(): Boolean {
        throw UnsupportedOperationException("this operation is not supported on StreamDownloadTask.")
    }

    internal fun start(): StreamDownloadTask {
        if (targetReference.wirePath.isEmpty()) {
            val rootError = StorageException.fromException(
                IllegalArgumentException("Cannot stream from getRoot. Stream from a child reference instead.")
            )
            tryCompleteFailure(rootError)
            return this
        }
        workerJob = targetReference.storage.storageScope.launch {
            runStreamLoop()
        }
        return this
    }

    private suspend fun runStreamLoop() {
        try {
            awaitActiveOrThrowCanceled()
            val head = ChunkedDownloadDriver.fetchHead(targetReference)
            val stream = RangedStorageInputStream(
                reference = targetReference,
                head = head,
                chunkSize = chunkSizeBytes,
                isTaskCanceled = { isCanceled() },
                onBytesConsumed = ::recordStreamProgress
            )
            val openedSnap = synchronized(stateLock) {
                activeStream = stream
                totalBytesKnown = head.totalBytes
                buildSnapshotLocked(error = null, streamOverride = stream).also { latestSnapshot = it }
            }
            if (isCanceled()) {
                runCatching { stream.close() }
                return
            }
            notifyProgressIfActive(openedSnap)

            val customProcessor = processor
            if (customProcessor != null) {
                try {
                    customProcessor.doInBackground(openedSnap, stream)
                } finally {
                    runCatching { stream.close() }
                }
                if (isCanceled()) {
                    return
                }
                val completedSnap = synchronized(stateLock) {
                    buildSnapshotLocked(error = null, streamOverride = stream).also { latestSnapshot = it }
                }
                tryCompleteSuccess(completedSnap)
            } else {
                tryCompleteSuccess(openedSnap)
            }
        } catch (_: CancellationException) {
            // Cancel transition handles terminal state directly.
        } catch (t: Throwable) {
            if (!isCanceled()) {
                tryCompleteFailure(StorageException.fromWireException(t))
            }
        }
    }

    private fun recordStreamProgress(newTotalRead: Long) {
        val snap = synchronized(stateLock) {
            transferredBytes = newTotalRead
            val streamRef = activeStream ?: placeholderStream
            buildSnapshotLocked(error = null, streamOverride = streamRef).also { latestSnapshot = it }
        }
        notifyProgressIfActive(snap)
    }

    override fun onCanceledTransitionLocked(cancelError: StorageException) {
        activeStream?.abortFromCancel()
        val streamRef = activeStream ?: placeholderStream
        latestSnapshot = buildSnapshotLocked(error = cancelError, streamOverride = streamRef)
    }

    override fun onCanceledCleanup() {
        val stream = synchronized(stateLock) { activeStream }
        runCatching { stream?.close() }
        workerJob?.cancel()
    }

    override fun onSuccessTransitionLocked(finalSnapshot: TaskSnapshot) {
        latestSnapshot = finalSnapshot
    }

    override fun onFailureTransitionLocked(error: StorageException) {
        val streamRef = activeStream ?: placeholderStream
        latestSnapshot = buildSnapshotLocked(error = error, streamOverride = streamRef)
    }

    private fun buildSnapshotLocked(error: Exception?, streamOverride: InputStream): TaskSnapshot =
        TaskSnapshot(
            error = error ?: exception,
            bytesTransferred = transferredBytes,
            totalByteCount = totalBytesKnown,
            stream = streamOverride
        )
}

internal class RangedStorageInputStream(
    private val reference: StorageReference,
    private val head: DownloadObjectHead,
    private val chunkSize: Int,
    private val isTaskCanceled: () -> Boolean,
    private val onBytesConsumed: (Long) -> Unit
) : InputStream() {
    private val streamLock = Any()
    private var closed = false
    private var nextFetchOffset: Long = 0L
    private var totalConsumed: Long = 0L
    private var currentBuffer: ByteArray = ByteArray(0)
    private var bufferCursor: Int = 0
    private var inFlightSignal: TransferCancelSignal? = null

    fun abortFromCancel() {
        val sig = synchronized(streamLock) { inFlightSignal }
        sig?.abort()
    }

    override fun read(): Int {
        val single = ByteArray(1)
        val count = read(single, 0, 1)
        return if (count == -1) -1 else single[0].toInt() and 0xFF
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (off < 0 || len < 0 || len > b.size - off) {
            throw IndexOutOfBoundsException("Invalid offset=$off, length=$len for buffer size=${b.size}")
        }
        if (len == 0) {
            return 0
        }
        val copied: Int
        val consumedAfter: Long
        synchronized(streamLock) {
            ensureOpenAndNotCanceledLocked()
            if (bufferCursor >= currentBuffer.size) {
                if (nextFetchOffset >= head.totalBytes) {
                    return -1
                }
                refillBufferLocked()
                if (currentBuffer.isEmpty()) {
                    return -1
                }
            }
            val available = currentBuffer.size - bufferCursor
            copied = minOf(available, len)
            System.arraycopy(currentBuffer, bufferCursor, b, off, copied)
            bufferCursor += copied
            totalConsumed += copied.toLong()
            consumedAfter = totalConsumed
        }
        onBytesConsumed(consumedAfter)
        return copied
    }

    private fun refillBufferLocked() {
        val toRead = minOf(chunkSize.toLong(), head.totalBytes - nextFetchOffset).toInt()
        val signal = TransferCancelSignal()
        inFlightSignal = signal
        val fetched = try {
            runBlocking {
                ChunkedDownloadDriver.readChunk(
                    reference = reference,
                    head = head,
                    offset = nextFetchOffset,
                    length = toRead,
                    cancelSignal = signal
                )
            }
        } catch (t: Throwable) {
            ensureOpenAndNotCanceledLocked()
            throw IOException("Failed reading Storage stream for '${reference.wirePath}'.", t)
        } finally {
            if (inFlightSignal === signal) {
                inFlightSignal = null
            }
        }
        ensureOpenAndNotCanceledLocked()
        nextFetchOffset += fetched.size.toLong()
        currentBuffer = fetched
        bufferCursor = 0
    }

    private fun ensureOpenAndNotCanceledLocked() {
        if (isTaskCanceled()) {
            throw IOException(
                "Stream download was canceled.",
                StorageException(StorageException.ERROR_CANCELED)
            )
        }
        if (closed) {
            throw IOException("Stream is closed.")
        }
    }

    override fun close() {
        val sig = synchronized(streamLock) {
            closed = true
            val s = inFlightSignal
            inFlightSignal = null
            s
        }
        sig?.abort()
    }
}
