package com.google.firebase.storage

import com.google.firebase.firestore.FirebaseFirestoreException
import java.net.URI
import java.util.Base64

internal object BridgeStorageOperations {
    internal const val MAX_STORAGE_OP_BYTES: Int = 8 * 1024 * 1024
    internal const val MAX_STORAGE_PART_BYTES: Int = 4 * 1024 * 1024
    internal const val MAX_STORAGE_OBJECT_BYTES: Long = 512L * 1024L * 1024L
    private const val ADMIN_SET_METADATA_GATE_SUBSTRING: String =
        "storage.setMetadata is the admin plane"

    internal fun bucketWireParams(reference: StorageReference): Map<String, Any?> {
        val params = LinkedHashMap<String, Any?>()
        if (reference.storage.usesNamedBucket) {
            params["bucket"] = reference.bucket
        }
        val configuredDefault = reference.storage.defaultBucketName
        if (!configuredDefault.isNullOrEmpty()) {
            params["defaultBucket"] = configuredDefault
        }
        return params
    }

    internal suspend fun executeStorageOp(
        reference: StorageReference,
        method: String,
        params: Map<String, Any?>,
        timeoutMs: Long
    ): Any? {
        val mergedParams = LinkedHashMap<String, Any?>(params.size + 2)
        mergedParams.putAll(bucketWireParams(reference))
        mergedParams.putAll(params)
        val actAs = reference.storage.getEffectiveAuthLens().toMap()
        return reference.storage.bridgeClient.op(
            method = method,
            params = mergedParams,
            actAs = actAs,
            timeoutMs = timeoutMs.coerceAtLeast(1_000L)
        )
    }

    suspend fun putBytes(
        reference: StorageReference,
        bytes: ByteArray,
        metadata: StorageMetadata?,
        onProgress: ((Long) -> Unit)? = null
    ): StorageMetadata {
        if (bytes.size.toLong() > MAX_STORAGE_OBJECT_BYTES) {
            throw StorageException(StorageException.ERROR_QUOTA_EXCEEDED)
        }
        val client = reference.storage.bridgeClient
        if (StorageByteRouteClient.isHttpByteRouteKnown(client)) {
            return StorageByteRouteClient.uploadOverRoute(reference, bytes, metadata, onProgress)
        }
        return try {
            uploadAsFrames(reference, bytes, metadata, onProgress)
        } catch (t: Throwable) {
            if (StorageByteRouteClient.isByteRouteRefusal(t)) {
                StorageByteRouteClient.markHttpByteRoute(client)
                StorageByteRouteClient.uploadOverRoute(reference, bytes, metadata, onProgress)
            } else {
                throw StorageException.fromWireException(t)
            }
        }
    }

    private suspend fun uploadAsFrames(
        reference: StorageReference,
        bytes: ByteArray,
        metadata: StorageMetadata?,
        onProgress: ((Long) -> Unit)?
    ): StorageMetadata {
        val timeoutMs = reference.storage.maxUploadRetryTimeMillis
        val wireMeta = metadata?.toUploadWireMap() ?: emptyMap()
        val contentType = metadata?.contentType?.takeIf { it.isNotEmpty() }

        if (bytes.size <= MAX_STORAGE_PART_BYTES) {
            val params = LinkedHashMap<String, Any?>()
            params["path"] = reference.wirePath
            params["dataB64"] = Base64.getEncoder().encodeToString(bytes)
            if (contentType != null) params["contentType"] = contentType
            if (wireMeta.isNotEmpty()) params["metadata"] = wireMeta

            val raw = executeStorageOp(reference, "storage.putBytes", params, timeoutMs)
            onProgress?.invoke(bytes.size.toLong())
            return parseMetadataReply(raw, reference)
        }

        val beginParams = LinkedHashMap<String, Any?>()
        beginParams["path"] = reference.wirePath
        beginParams["size"] = bytes.size
        if (contentType != null) beginParams["contentType"] = contentType
        if (wireMeta.isNotEmpty()) beginParams["metadata"] = wireMeta

        @Suppress("UNCHECKED_CAST")
        val beginRes = executeStorageOp(reference, "storage.beginUpload", beginParams, timeoutMs) as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.beginUpload reply.")
        val uploadId = beginRes["uploadId"] as? String
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Missing uploadId in storage.beginUpload reply.")

        try {
            var offset = 0
            var partIndex = 0
            while (offset < bytes.size) {
                val end = minOf(offset + MAX_STORAGE_PART_BYTES, bytes.size)
                val slice = bytes.copyOfRange(offset, end)
                val partParams = mapOf(
                    "uploadId" to uploadId,
                    "partIndex" to partIndex,
                    "dataB64" to Base64.getEncoder().encodeToString(slice)
                )
                try {
                    reference.storage.bridgeClient.op(
                        method = "storage.putPart",
                        params = partParams,
                        actAs = reference.storage.getEffectiveAuthLens().toMap(),
                        timeoutMs = timeoutMs.coerceAtLeast(1_000L)
                    )
                } catch (partErr: Throwable) {
                    if (StorageByteRouteClient.isByteRouteRefusal(partErr)) {
                        StorageByteRouteClient.markHttpByteRoute(reference.storage.bridgeClient)
                        val uploadUrl = beginRes["uploadUrl"] as? String
                        if (uploadUrl != null) {
                            return StorageByteRouteClient.sendHttpSlicesAndFinish(
                                reference,
                                uploadId,
                                uploadUrl,
                                bytes,
                                onProgress
                            )
                        }
                    }
                    throw partErr
                }
                offset = end
                partIndex += 1
                onProgress?.invoke(offset.toLong())
            }
            val finishRes = reference.storage.bridgeClient.op(
                method = "storage.finishUpload",
                params = mapOf("uploadId" to uploadId),
                actAs = reference.storage.getEffectiveAuthLens().toMap(),
                timeoutMs = timeoutMs.coerceAtLeast(1_000L)
            )
            return parseMetadataReply(finishRes, reference)
        } catch (err: Throwable) {
            bestEffortAbortUpload(reference, uploadId)
            throw err
        }
    }

    internal suspend fun bestEffortAbortUpload(reference: StorageReference, uploadId: String) {
        try {
            reference.storage.bridgeClient.op(
                method = "storage.abortUpload",
                params = mapOf("uploadId" to uploadId),
                actAs = reference.storage.getEffectiveAuthLens().toMap(),
                timeoutMs = 5_000L
            )
        } catch (_: Throwable) {}
    }

    suspend fun getBytes(reference: StorageReference, maxDownloadSizeBytes: Long): ByteArray {
        val rawBytes = readRawObjectBytes(reference, maxDownloadSizeBytes)
        if (rawBytes.size.toLong() > maxDownloadSizeBytes) {
            throw exceedBufferLimitException()
        }
        return rawBytes
    }

    internal suspend fun readRawObjectBytes(
        reference: StorageReference,
        maxAllowedBytes: Long? = null
    ): ByteArray {
        val client = reference.storage.bridgeClient
        if (StorageByteRouteClient.isHttpByteRouteKnown(client)) {
            return StorageByteRouteClient.downloadOverRoute(reference, maxAllowedBytes)
        }
        return try {
            downloadAsFrames(reference, maxAllowedBytes)
        } catch (t: Throwable) {
            if (StorageByteRouteClient.isByteRouteRefusal(t)) {
                StorageByteRouteClient.markHttpByteRoute(client)
                StorageByteRouteClient.downloadOverRoute(reference, maxAllowedBytes)
            } else {
                throw StorageException.fromWireException(t)
            }
        }
    }

    private suspend fun downloadAsFrames(
        reference: StorageReference,
        maxAllowedBytes: Long?
    ): ByteArray {
        val timeoutMs = reference.storage.maxDownloadRetryTimeMillis
        try {
            val res = executeStorageOp(
                reference,
                "storage.getBytes",
                mapOf("path" to reference.wirePath),
                timeoutMs
            )
            @Suppress("UNCHECKED_CAST")
            val resMap = res as? Map<String, Any?>
                ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.getBytes reply.")
            val dataB64 = resMap["dataB64"] as? String ?: ""
            val decoded = Base64.getDecoder().decode(dataB64)
            if (maxAllowedBytes != null && decoded.size.toLong() > maxAllowedBytes) {
                throw exceedBufferLimitException()
            }
            return decoded
        } catch (err: Throwable) {
            val fsErr = err as? FirebaseFirestoreException
            val isTooLargeForSingleFrame = fsErr?.wireCode == "payload-too-large"
            if (!isTooLargeForSingleFrame) {
                throw err
            }
            val meta = getMetadata(reference)
            if (maxAllowedBytes != null && meta.sizeBytes > maxAllowedBytes) {
                throw exceedBufferLimitException()
            }
            val totalSize = meta.sizeBytes.toInt()
            val assembled = ByteArray(totalSize)
            var offset = 0
            val gen = meta.generation
            while (offset < totalSize) {
                val length = minOf(MAX_STORAGE_PART_BYTES, totalSize - offset)
                val chunkParams = LinkedHashMap<String, Any?>()
                chunkParams["path"] = reference.wirePath
                chunkParams["offset"] = offset
                chunkParams["length"] = length
                if (gen != null) {
                    chunkParams["expectedGeneration"] = gen
                }
                val chunkRes = executeStorageOp(reference, "storage.getBytes", chunkParams, timeoutMs)
                @Suppress("UNCHECKED_CAST")
                val chunkMap = chunkRes as? Map<String, Any?>
                    ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed chunk reply.")
                val partBytes = Base64.getDecoder().decode((chunkMap["dataB64"] as? String) ?: "")
                System.arraycopy(partBytes, 0, assembled, offset, partBytes.size)
                offset += partBytes.size
            }
            return assembled
        }
    }

    suspend fun getMetadata(reference: StorageReference): StorageMetadata {
        val timeoutMs = reference.storage.maxOperationRetryTimeMillis
        val raw = try {
            executeStorageOp(
                reference,
                "storage.getMetadata",
                mapOf("path" to reference.wirePath),
                timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }
        return parseMetadataReply(raw, reference)
    }

    suspend fun updateMetadata(
        reference: StorageReference,
        patchMetadata: StorageMetadata
    ): StorageMetadata {
        val timeoutMs = reference.storage.maxOperationRetryTimeMillis
        val patchWire = patchMetadata.toSetMetadataPatchWireMap()
        try {
            val raw = executeStorageOp(
                reference,
                "storage.updateMetadata",
                mapOf("path" to reference.wirePath, "patch" to patchWire),
                timeoutMs
            )
            return parseMetadataReply(raw, reference)
        } catch (t: Throwable) {
            val msg = t.message?.lowercase() ?: ""
            val wireCode = (t as? com.google.firebase.firestore.FirebaseFirestoreException)
                ?.wireCode
                ?.lowercase() ?: ""
            val unsupportedOp = wireCode == "unimplemented" ||
                msg.contains("unknown method") ||
                msg.contains("unknown op") ||
                msg.contains("unsupported")
            if (!unsupportedOp) {
                throw StorageException.fromWireException(t)
            }
        }

        try {
            val raw = executeStorageOp(
                reference,
                "storage.setMetadata",
                mapOf("path" to reference.wirePath, "patch" to patchWire),
                timeoutMs
            )
            return parseMetadataReply(raw, reference)
        } catch (t: Throwable) {
            val msg = t.message ?: ""
            if (!msg.contains(ADMIN_SET_METADATA_GATE_SUBSTRING)) {
                throw StorageException.fromWireException(t)
            }
        }

        val existing = getMetadata(reference)
        val existingBytes = readRawObjectBytes(reference, null)
        val merged = patchMetadata.mergeOntoExistingForUpload(existing)
        return putBytes(reference, existingBytes, merged, null)
    }

    suspend fun getDownloadUrl(reference: StorageReference): URI {
        val timeoutMs = reference.storage.maxOperationRetryTimeMillis
        val raw = try {
            executeStorageOp(
                reference,
                "storage.getDownloadURL",
                mapOf("path" to reference.wirePath),
                timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }

        val urlOrPath: String = when (raw) {
            is String -> raw
            is Map<*, *> -> (raw["url"] as? String)
                ?: (raw["downloadUrl"] as? String)
                ?: (raw["path"] as? String)
                ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Missing URL in storage.getDownloadURL reply.")
            else -> throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.getDownloadURL reply.")
        }

        val resolved = if (urlOrPath.startsWith("http://") ||
            urlOrPath.startsWith("https://") ||
            urlOrPath.startsWith("data:")
        ) {
            urlOrPath
        } else {
            StorageByteRouteClient.resolveHttpUrl(reference.storage.bridgeClient.url, urlOrPath)
        }
        return try {
            URI.create(resolved)
        } catch (e: IllegalArgumentException) {
            throw StorageException(StorageException.ERROR_UNKNOWN, "Invalid download URL: $resolved", 0, e)
        }
    }

    suspend fun delete(reference: StorageReference) {
        val timeoutMs = reference.storage.maxOperationRetryTimeMillis
        try {
            executeStorageOp(
                reference,
                "storage.deleteObject",
                mapOf("path" to reference.wirePath),
                timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }
    }

    suspend fun listAll(reference: StorageReference): ListResult =
        StorageListPaginator.listAll(reference)

    suspend fun list(
        reference: StorageReference,
        maxResults: Int,
        pageToken: String?
    ): ListResult = StorageListPaginator.list(reference, maxResults, pageToken)

    internal fun parseMetadataReply(raw: Any?, reference: StorageReference): StorageMetadata {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed StorageMetadata wire response.")
        return StorageMetadata.fromWireMap(map, reference)
    }

    internal fun exceedBufferLimitException(): StorageException {
        val cause = IndexOutOfBoundsException("the maximum allowed buffer size was exceeded.")
        return StorageException(
            errorCode = StorageException.ERROR_UNKNOWN,
            detailMessage = "the maximum allowed buffer size was exceeded.",
            httpResultCode = 0,
            cause = cause
        )
    }
}
