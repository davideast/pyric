package com.google.firebase.storage

import com.google.firebase.firestore.FirebaseFirestoreException
import java.net.ConnectException
import java.net.URI
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

internal data class StagedUploadSession(
    val uploadId: String,
    val rawUploadUrl: String?,
    val resolvedHttpUrl: String?,
    val sessionUri: URI
)

internal data class CommittedUploadReceipt(
    val metadata: StorageMetadata,
    val rollbackToken: String?,
    val replacedObject: Boolean
)

internal object ChunkedUploadDriver {
    internal const val DEFAULT_UPLOAD_CHUNK_BYTES: Int = 256 * 1024

    private val stagedFrameOffsets = ConcurrentHashMap<String, Long>()

    fun isUnsupportedChunkedOp(error: Throwable): Boolean {
        val msg = (error.message ?: "").lowercase()
        val fsErr = error as? FirebaseFirestoreException
        val code = (fsErr?.wireCode ?: "").lowercase().removePrefix("storage/")
        return code == "unsupported" ||
            code == "unimplemented" ||
            msg.contains("unknown method: storage.beginupload") ||
            msg.contains("does not support chunked uploads")
    }

    suspend fun beginSession(
        reference: StorageReference,
        totalBytes: Long,
        contentType: String?,
        metadata: StorageMetadata?
    ): StagedUploadSession {
        if (totalBytes > BridgeStorageOperations.MAX_STORAGE_OBJECT_BYTES) {
            throw StorageException(StorageException.ERROR_QUOTA_EXCEEDED)
        }
        val timeoutMs = reference.storage.maxUploadRetryTimeMillis
        val wireMeta = metadata?.toUploadWireMap() ?: emptyMap()
        val effectiveContentType = contentType?.takeIf { it.isNotEmpty() }
            ?: metadata?.contentType?.takeIf { it.isNotEmpty() }

        val beginParams = LinkedHashMap<String, Any?>()
        beginParams["path"] = reference.wirePath
        beginParams["size"] = totalBytes
        if (effectiveContentType != null) {
            beginParams["contentType"] = effectiveContentType
        }
        if (wireMeta.isNotEmpty()) {
            beginParams["metadata"] = wireMeta
        }

        val raw = BridgeStorageOperations.executeStorageOp(
            reference = reference,
            method = "storage.beginUpload",
            params = beginParams,
            timeoutMs = timeoutMs
        )
        @Suppress("UNCHECKED_CAST")
        val reply = raw as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.beginUpload reply.")
        val uploadId = reply["uploadId"] as? String
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Missing uploadId in storage.beginUpload reply.")
        val rawUploadUrl = (reply["uploadUrl"] as? String)?.takeIf { it.isNotEmpty() }
        val resolvedHttpUrl = rawUploadUrl?.let {
            StorageByteRouteClient.resolveHttpUrl(reference.storage.bridgeClient.url, it)
        }
        val sessionUri = if (resolvedHttpUrl != null) {
            safeParseSessionUri(resolvedHttpUrl, reference, uploadId)
        } else {
            buildSyntheticSessionUri(reference, uploadId)
        }
        stagedFrameOffsets[uploadId] = 0L
        return StagedUploadSession(
            uploadId = uploadId,
            rawUploadUrl = rawUploadUrl,
            resolvedHttpUrl = resolvedHttpUrl,
            sessionUri = sessionUri
        )
    }

    private fun safeParseSessionUri(
        resolvedHttpUrl: String,
        reference: StorageReference,
        uploadId: String
    ): URI {
        try {
            return URI.create(resolvedHttpUrl)
        } catch (_: IllegalArgumentException) {
            return try {
                URI.create(resolvedHttpUrl.replace(" ", "%20"))
            } catch (_: IllegalArgumentException) {
                buildSyntheticSessionUri(reference, uploadId)
            }
        }
    }

    private fun buildSyntheticSessionUri(reference: StorageReference, uploadId: String): URI {
        val encodedBucket = StorageUrlParser.encodeUriComponent(reference.bucket)
        val encodedPath = StorageUrlParser.encodeUriComponent(reference.wirePath)
        val encodedId = StorageUrlParser.encodeUriComponent(uploadId)
        return URI.create("pyric-upload://$encodedBucket/$encodedPath?upload_id=$encodedId")
    }

    fun restoreSessionFromUri(
        reference: StorageReference,
        existingUploadUri: URI
    ): StagedUploadSession {
        val uploadId = extractQueryParam(existingUploadUri, "upload_id")
            ?: extractQueryParam(existingUploadUri, "uploadId")
            ?: throw StorageException(
                StorageException.ERROR_UNKNOWN,
                "existingUploadUri does not contain an upload_id query parameter."
            )
        val scheme = existingUploadUri.scheme?.lowercase() ?: ""
        val resolvedHttpUrl = if (scheme == "http" || scheme == "https") {
            existingUploadUri.toString()
        } else if (existingUploadUri.toString().startsWith("/")) {
            StorageByteRouteClient.resolveHttpUrl(
                reference.storage.bridgeClient.url,
                existingUploadUri.toString()
            )
        } else {
            null
        }
        return StagedUploadSession(
            uploadId = uploadId,
            rawUploadUrl = resolvedHttpUrl,
            resolvedHttpUrl = resolvedHttpUrl,
            sessionUri = existingUploadUri
        )
    }

    suspend fun queryReceivedOffset(
        reference: StorageReference,
        session: StagedUploadSession,
        totalBytes: Long,
        cancelSignal: TransferCancelSignal?
    ): Long {
        val client = reference.storage.bridgeClient
        val httpUrl = session.resolvedHttpUrl
        if (httpUrl != null && StorageByteRouteClient.isHttpByteRouteKnown(client)) {
            return StorageByteRouteClient.queryHttpUploadOffset(
                reference = reference,
                resolvedUploadUrl = httpUrl,
                totalBytes = totalBytes,
                cancelSignal = cancelSignal
            )
        }
        if (httpUrl != null) {
            try {
                val probed = StorageByteRouteClient.queryHttpUploadOffset(
                    reference = reference,
                    resolvedUploadUrl = httpUrl,
                    totalBytes = totalBytes,
                    cancelSignal = cancelSignal
                )
                StorageByteRouteClient.markHttpByteRoute(client)
                return probed
            } catch (_: ConnectException) {
                // In-memory bridge without an HTTP server listening; fall back to frame tracking.
            }
        }
        return stagedFrameOffsets[session.uploadId] ?: 0L
    }

    suspend fun sendChunk(
        reference: StorageReference,
        session: StagedUploadSession,
        partIndex: Int,
        uploadOffset: Long,
        totalBytes: Long,
        chunk: ByteArray,
        chunkLength: Int,
        cancelSignal: TransferCancelSignal?
    ): Long {
        if (chunkLength <= 0) {
            return uploadOffset
        }
        val client = reference.storage.bridgeClient
        val httpUrl = session.resolvedHttpUrl
        if (StorageByteRouteClient.isHttpByteRouteKnown(client)) {
            val targetUrl = httpUrl
                ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Host requires HTTP byte route but provided no uploadUrl.")
            return StorageByteRouteClient.sendHttpSlice(
                reference = reference,
                resolvedUploadUrl = targetUrl,
                slice = chunk,
                sliceArrayOffset = 0,
                sliceByteCount = chunkLength,
                uploadOffset = uploadOffset,
                totalBytes = totalBytes,
                cancelSignal = cancelSignal
            )
        }

        val sliceBytes = if (chunkLength == chunk.size) chunk else chunk.copyOfRange(0, chunkLength)
        val partParams = mapOf(
            "uploadId" to session.uploadId,
            "partIndex" to partIndex,
            "dataB64" to Base64.getEncoder().encodeToString(sliceBytes)
        )
        val timeoutMs = reference.storage.maxChunkUploadRetry.coerceAtLeast(1_000L)
        return try {
            client.op(
                method = "storage.putPart",
                params = partParams,
                actAs = reference.storage.getEffectiveAuthLens().toMap(),
                timeoutMs = timeoutMs
            )
            val nextOffset = uploadOffset + chunkLength.toLong()
            stagedFrameOffsets[session.uploadId] = nextOffset
            nextOffset
        } catch (t: Throwable) {
            if (StorageByteRouteClient.isByteRouteRefusal(t) && httpUrl != null) {
                StorageByteRouteClient.markHttpByteRoute(client)
                StorageByteRouteClient.sendHttpSlice(
                    reference = reference,
                    resolvedUploadUrl = httpUrl,
                    slice = chunk,
                    sliceArrayOffset = 0,
                    sliceByteCount = chunkLength,
                    uploadOffset = uploadOffset,
                    totalBytes = totalBytes,
                    cancelSignal = cancelSignal
                )
            } else {
                throw StorageException.fromWireException(t)
            }
        }
    }

    suspend fun finishSession(
        reference: StorageReference,
        session: StagedUploadSession,
        requestRollback: Boolean
    ): CommittedUploadReceipt {
        val params = LinkedHashMap<String, Any?>()
        params["uploadId"] = session.uploadId
        if (requestRollback) {
            params["rollback"] = true
        }
        val timeoutMs = reference.storage.maxUploadRetryTimeMillis.coerceAtLeast(1_000L)
        val raw = try {
            reference.storage.bridgeClient.op(
                method = "storage.finishUpload",
                params = params,
                actAs = reference.storage.getEffectiveAuthLens().toMap(),
                timeoutMs = timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        } finally {
            stagedFrameOffsets.remove(session.uploadId)
        }
        return parseCommittedReceipt(raw, reference)
    }

    suspend fun singleFrameUploadWithRollback(
        reference: StorageReference,
        bytes: ByteArray,
        contentType: String?,
        metadata: StorageMetadata?
    ): CommittedUploadReceipt {
        val wireMeta = metadata?.toUploadWireMap() ?: emptyMap()
        val effectiveContentType = contentType?.takeIf { it.isNotEmpty() }
            ?: metadata?.contentType?.takeIf { it.isNotEmpty() }
        val params = LinkedHashMap<String, Any?>()
        params["path"] = reference.wirePath
        params["dataB64"] = Base64.getEncoder().encodeToString(bytes)
        params["rollback"] = true
        if (effectiveContentType != null) {
            params["contentType"] = effectiveContentType
        }
        if (wireMeta.isNotEmpty()) {
            params["metadata"] = wireMeta
        }
        val timeoutMs = reference.storage.maxUploadRetryTimeMillis.coerceAtLeast(1_000L)
        val raw = try {
            BridgeStorageOperations.executeStorageOp(reference, "storage.putBytes", params, timeoutMs)
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }
        return parseCommittedReceipt(raw, reference)
    }

    suspend fun abortSession(reference: StorageReference, uploadId: String) {
        stagedFrameOffsets.remove(uploadId)
        BridgeStorageOperations.bestEffortAbortUpload(reference, uploadId)
    }

    suspend fun rollbackCommittedUpload(
        reference: StorageReference,
        receipt: CommittedUploadReceipt
    ) {
        val token = receipt.rollbackToken
        if (!token.isNullOrEmpty()) {
            try {
                reference.storage.bridgeClient.op(
                    method = "storage.rollbackUpload",
                    params = mapOf("rollbackToken" to token),
                    actAs = reference.storage.getEffectiveAuthLens().toMap(),
                    timeoutMs = reference.storage.maxOperationRetryTimeMillis.coerceAtLeast(1_000L)
                )
                return
            } catch (t: Throwable) {
                val mapped = StorageException.fromWireException(t)
                if (mapped.errorCode != StorageException.ERROR_NOT_AUTHORIZED) {
                    throw mapped
                }
            }
        }
        if (receipt.replacedObject) {
            throw StorageException(
                StorageException.ERROR_UNKNOWN,
                "The host no longer holds the object this upload replaced, so it cannot be restored."
            )
        }
        try {
            BridgeStorageOperations.delete(reference)
        } catch (e: StorageException) {
            if (e.errorCode != StorageException.ERROR_OBJECT_NOT_FOUND) {
                throw e
            }
        }
    }

    private fun parseCommittedReceipt(raw: Any?, reference: StorageReference): CommittedUploadReceipt {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed upload commit response.")
        val rollbackToken = (map["rollbackToken"] as? String)?.takeIf { it.isNotEmpty() }
        val replacedObject = map["replacedObject"] == true
        val metadata = StorageMetadata.fromWireMap(map, reference)
        return CommittedUploadReceipt(
            metadata = metadata,
            rollbackToken = rollbackToken,
            replacedObject = replacedObject
        )
    }

    private fun extractQueryParam(uri: URI, targetKey: String): String? {
        val rawQuery = uri.rawQuery ?: return null
        for (pair in rawQuery.split('&')) {
            val eq = pair.indexOf('=')
            if (eq > 0) {
                val key = decodeComponent(pair.substring(0, eq))
                if (key == targetKey) {
                    return decodeComponent(pair.substring(eq + 1))
                }
            }
        }
        return null
    }

    private fun decodeComponent(encoded: String): String =
        URLDecoder.decode(encoded.replace("+", "%2B"), StandardCharsets.UTF_8.name())
}
