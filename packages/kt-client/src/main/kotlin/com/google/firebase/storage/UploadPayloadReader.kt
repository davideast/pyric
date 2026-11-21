package com.google.firebase.storage

import java.io.File
import java.io.FileNotFoundException
import java.io.InputStream
import java.io.RandomAccessFile
import java.net.URI
import java.net.URLConnection
import java.nio.file.Files
import java.nio.file.Paths

internal sealed class UploadPayloadSource {
    class Bytes(val data: ByteArray) : UploadPayloadSource()
    class Stream(val inputStream: InputStream) : UploadPayloadSource()
    class LocalFile(val uri: URI, val existingUploadUri: URI?) : UploadPayloadSource()
}

internal data class OpenedLocalUploadFile(
    val file: File,
    val totalBytes: Long,
    val inferredContentType: String?
)

internal object UploadPayloadReader {

    fun computeInitialTotalBytes(source: UploadPayloadSource): Long = when (source) {
        is UploadPayloadSource.Bytes -> source.data.size.toLong()
        is UploadPayloadSource.Stream -> -1L
        is UploadPayloadSource.LocalFile -> runCatching {
            val f = resolveLocalFile(source.uri)
            if (f.exists() && f.isFile) f.length() else -1L
        }.getOrDefault(-1L)
    }

    fun initialExistingUri(source: UploadPayloadSource): URI? = when (source) {
        is UploadPayloadSource.LocalFile -> source.existingUploadUri
        else -> null
    }

    fun resolveLocalFile(uri: URI): File {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "file") {
            throw IllegalArgumentException("Expected a file:// URI, got: $uri")
        }
        return try {
            Paths.get(uri).toFile()
        } catch (_: Throwable) {
            val rawPath = uri.path ?: throw IllegalArgumentException("URI has no file path: $uri")
            File(rawPath)
        }
    }

    fun openValidatedLocalFile(uri: URI): OpenedLocalUploadFile {
        val localFile = resolveLocalFile(uri)
        if (!localFile.exists() || !localFile.isFile) {
            throw StorageException.fromException(
                FileNotFoundException("Local upload file does not exist: ${localFile.path}")
            )
        }
        val totalBytes = localFile.length()
        if (totalBytes > BridgeStorageOperations.MAX_STORAGE_OBJECT_BYTES) {
            throw StorageException(StorageException.ERROR_QUOTA_EXCEEDED)
        }
        return OpenedLocalUploadFile(
            file = localFile,
            totalBytes = totalBytes,
            inferredContentType = inferFileContentType(localFile)
        )
    }

    fun readFileRange(raf: RandomAccessFile, offset: Long, length: Int): ByteArray {
        val buf = ByteArray(length)
        raf.seek(offset)
        raf.readFully(buf)
        return buf
    }

    fun inferFileContentType(file: File): String? =
        runCatching { Files.probeContentType(file.toPath()) }.getOrNull()
            ?: URLConnection.guessContentTypeFromName(file.name)

    suspend fun spoolStreamInBoundedChunks(
        stream: InputStream,
        chunkSizeBytes: Int,
        awaitActive: suspend () -> Unit
    ): List<ByteArray> {
        val chunks = ArrayList<ByteArray>()
        val readBuffer = ByteArray(minOf(64 * 1024, chunkSizeBytes.coerceAtLeast(4 * 1024)))
        var currentSegment = ByteArray(chunkSizeBytes)
        var currentFill = 0
        var totalSpooled = 0L

        try {
            while (true) {
                awaitActive()
                val readCount = stream.read(readBuffer)
                if (readCount == -1) {
                    break
                }
                if (readCount == 0) {
                    continue
                }
                totalSpooled += readCount.toLong()
                if (totalSpooled > BridgeStorageOperations.MAX_STORAGE_OBJECT_BYTES) {
                    throw StorageException(StorageException.ERROR_QUOTA_EXCEEDED)
                }
                var cursor = 0
                while (cursor < readCount) {
                    val space = chunkSizeBytes - currentFill
                    val toCopy = minOf(space, readCount - cursor)
                    System.arraycopy(readBuffer, cursor, currentSegment, currentFill, toCopy)
                    currentFill += toCopy
                    cursor += toCopy
                    if (currentFill == chunkSizeBytes) {
                        chunks.add(currentSegment)
                        currentSegment = ByteArray(chunkSizeBytes)
                        currentFill = 0
                    }
                }
            }
            if (currentFill > 0) {
                chunks.add(currentSegment.copyOf(currentFill))
            }
            return chunks
        } finally {
            runCatching { stream.close() }
        }
    }

    fun sliceIntoSegments(bytes: ByteArray, chunkSize: Int): List<ByteArray> {
        if (bytes.isEmpty()) return emptyList()
        val segments = ArrayList<ByteArray>((bytes.size + chunkSize - 1) / chunkSize)
        var offset = 0
        while (offset < bytes.size) {
            val end = minOf(offset + chunkSize, bytes.size)
            segments.add(bytes.copyOfRange(offset, end))
            offset = end
        }
        return segments
    }

    fun flattenSegments(segments: List<ByteArray>, totalBytes: Int): ByteArray {
        val out = ByteArray(totalBytes)
        var pos = 0
        for (seg in segments) {
            System.arraycopy(seg, 0, out, pos, seg.size)
            pos += seg.size
        }
        return out
    }

    fun sliceFromSegments(segments: List<ByteArray>, offset: Long, length: Int): ByteArray {
        val out = ByteArray(length)
        var remaining = length
        var outPos = 0
        var currentStart = 0L
        for (seg in segments) {
            val segEnd = currentStart + seg.size.toLong()
            if (segEnd > offset && remaining > 0) {
                val inSegStart = (offset - currentStart).coerceAtLeast(0L).toInt()
                val available = seg.size - inSegStart
                val toCopy = minOf(available, remaining)
                System.arraycopy(seg, inSegStart, out, outPos, toCopy)
                outPos += toCopy
                remaining -= toCopy
                if (remaining == 0) break
            }
            currentStart = segEnd
        }
        return if (outPos == length) out else out.copyOf(outPos)
    }
}
