package com.google.firebase.storage

import java.util.Base64

internal data class DownloadObjectHead(
    val metadata: StorageMetadata,
    val bucketName: String,
    val totalBytes: Long,
    val generation: String?
)

internal object ChunkedDownloadDriver {
    internal const val DEFAULT_DOWNLOAD_CHUNK_BYTES: Int = 256 * 1024

    suspend fun fetchHead(reference: StorageReference): DownloadObjectHead {
        val meta = BridgeStorageOperations.getMetadata(reference)
        return DownloadObjectHead(
            metadata = meta,
            bucketName = meta.bucket ?: reference.bucket,
            totalBytes = meta.sizeBytes,
            generation = meta.generation
        )
    }

    suspend fun readChunk(
        reference: StorageReference,
        head: DownloadObjectHead,
        offset: Long,
        length: Int,
        cancelSignal: TransferCancelSignal?
    ): ByteArray {
        if (length <= 0 || offset >= head.totalBytes) {
            return ByteArray(0)
        }
        val clampedLength = minOf(length.toLong(), head.totalBytes - offset).toInt()
        val client = reference.storage.bridgeClient
        if (StorageByteRouteClient.isHttpByteRouteKnown(client)) {
            return StorageByteRouteClient.downloadRangeOverRoute(
                reference = reference,
                bucketName = head.bucketName,
                generation = head.generation,
                offset = offset,
                length = clampedLength,
                cancelSignal = cancelSignal
            )
        }

        val chunkParams = LinkedHashMap<String, Any?>()
        chunkParams["path"] = reference.wirePath
        chunkParams["offset"] = offset
        chunkParams["length"] = clampedLength
        if (!head.generation.isNullOrEmpty()) {
            chunkParams["expectedGeneration"] = head.generation
        }
        val timeoutMs = reference.storage.maxDownloadRetryTimeMillis.coerceAtLeast(1_000L)

        return try {
            val raw = BridgeStorageOperations.executeStorageOp(
                reference = reference,
                method = "storage.getBytes",
                params = chunkParams,
                timeoutMs = timeoutMs
            )
            @Suppress("UNCHECKED_CAST")
            val reply = raw as? Map<String, Any?>
                ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.getBytes reply.")
            val decoded = Base64.getDecoder().decode((reply["dataB64"] as? String) ?: "")
            // If a simple unit-test stub ignored offset/length and returned the full object, slice locally.
            if (decoded.size > clampedLength && decoded.size.toLong() == head.totalBytes) {
                val start = offset.toInt()
                val end = minOf(start + clampedLength, decoded.size)
                decoded.copyOfRange(start, end)
            } else {
                decoded
            }
        } catch (t: Throwable) {
            if (StorageByteRouteClient.isByteRouteRefusal(t)) {
                StorageByteRouteClient.markHttpByteRoute(client)
                StorageByteRouteClient.downloadRangeOverRoute(
                    reference = reference,
                    bucketName = head.bucketName,
                    generation = head.generation,
                    offset = offset,
                    length = clampedLength,
                    cancelSignal = cancelSignal
                )
            } else {
                throw StorageException.fromWireException(t)
            }
        }
    }
}
