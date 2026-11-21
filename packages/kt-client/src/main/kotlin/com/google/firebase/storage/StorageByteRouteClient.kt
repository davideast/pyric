package com.google.firebase.storage

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.PyricBridgeClient
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

internal class TransferCancelSignal {
    private val lock = Any()
    private var aborted = false
    private var activeCall: Call? = null

    val isAborted: Boolean
        get() = synchronized(lock) { aborted }

    fun attach(call: Call) {
        val cancelImmediately = synchronized(lock) {
            if (aborted) {
                true
            } else {
                activeCall = call
                false
            }
        }
        if (cancelImmediately) {
            call.cancel()
        }
    }

    fun detach(call: Call) {
        synchronized(lock) {
            if (activeCall === call) {
                activeCall = null
            }
        }
    }

    fun abort() {
        val callToCancel = synchronized(lock) {
            aborted = true
            val current = activeCall
            activeCall = null
            current
        }
        callToCancel?.cancel()
    }
}

/**
 * HTTP byte-route transfer collaborator for hosts that advertise `storageByteRoute`
 * (`/__pyric/storage/v0/b/<bucket>/o/...`), mirroring `storage-byte-route.ts`.
 */
internal object StorageByteRouteClient {
    private const val STORAGE_ROUTE_PREFIX: String = "/__pyric/storage/v0/b/"

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private val byteRouteBridges: MutableSet<PyricBridgeClient> =
        Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    fun isHttpByteRouteKnown(client: PyricBridgeClient): Boolean =
        byteRouteBridges.contains(client)

    fun markHttpByteRoute(client: PyricBridgeClient) {
        byteRouteBridges.add(client)
    }

    fun isByteRouteRefusal(error: Throwable): Boolean {
        val fsError = error as? FirebaseFirestoreException ?: return false
        val code = (fsError.wireCode ?: "").lowercase()
        val msg = (fsError.message ?: "").lowercase()
        return code == "failed-precondition" && msg.contains("http byte route")
    }

    suspend fun uploadOverRoute(
        reference: StorageReference,
        bytes: ByteArray,
        metadata: StorageMetadata?,
        onProgress: ((Long) -> Unit)?
    ): StorageMetadata {
        val timeoutMs = reference.storage.maxUploadRetryTimeMillis
        val wireMeta = metadata?.toUploadWireMap() ?: emptyMap()
        val contentType = metadata?.contentType?.takeIf { it.isNotEmpty() }

        val beginParams = LinkedHashMap<String, Any?>()
        beginParams["path"] = reference.wirePath
        beginParams["size"] = bytes.size
        if (contentType != null) beginParams["contentType"] = contentType
        if (wireMeta.isNotEmpty()) beginParams["metadata"] = wireMeta

        val beginResRaw = try {
            BridgeStorageOperations.executeStorageOp(
                reference,
                "storage.beginUpload",
                beginParams,
                timeoutMs
            )
        } catch (t: Throwable) {
            throw StorageException.fromWireException(t)
        }

        @Suppress("UNCHECKED_CAST")
        val beginRes = beginResRaw as? Map<String, Any?>
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Malformed storage.beginUpload reply.")
        val uploadId = beginRes["uploadId"] as? String
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Missing uploadId in storage.beginUpload reply.")
        val uploadUrl = beginRes["uploadUrl"] as? String
            ?: throw StorageException(StorageException.ERROR_UNKNOWN, "Host began upload without uploadUrl.")

        try {
            return sendHttpSlicesAndFinish(reference, uploadId, uploadUrl, bytes, onProgress)
        } catch (err: Throwable) {
            BridgeStorageOperations.bestEffortAbortUpload(reference, uploadId)
            throw StorageException.fromWireException(err)
        }
    }

    suspend fun sendHttpSlicesAndFinish(
        reference: StorageReference,
        uploadId: String,
        uploadUrl: String,
        bytes: ByteArray,
        onProgress: ((Long) -> Unit)?
    ): StorageMetadata {
        val resolvedUrl = resolveHttpUrl(reference.storage.bridgeClient.url, uploadUrl)
        val total = bytes.size
        if (total == 0) {
            onProgress?.invoke(0L)
        }
        var offset = 0
        while (offset < total) {
            val endExclusive = minOf(offset + BridgeStorageOperations.MAX_STORAGE_PART_BYTES, total)
            val sliceLen = endExclusive - offset
            val nextOffset = sendHttpSlice(
                reference = reference,
                resolvedUploadUrl = resolvedUrl,
                slice = bytes,
                sliceArrayOffset = offset,
                sliceByteCount = sliceLen,
                uploadOffset = offset.toLong(),
                totalBytes = total.toLong(),
                cancelSignal = null
            )
            offset = nextOffset.toInt()
            onProgress?.invoke(nextOffset)
        }
        val finishRes = reference.storage.bridgeClient.op(
            method = "storage.finishUpload",
            params = mapOf("uploadId" to uploadId),
            actAs = reference.storage.getEffectiveAuthLens().toMap(),
            timeoutMs = reference.storage.maxUploadRetryTimeMillis.coerceAtLeast(1_000L)
        )
        return BridgeStorageOperations.parseMetadataReply(finishRes, reference)
    }

    suspend fun sendHttpSlice(
        reference: StorageReference,
        resolvedUploadUrl: String,
        slice: ByteArray,
        sliceArrayOffset: Int = 0,
        sliceByteCount: Int = slice.size,
        uploadOffset: Long,
        totalBytes: Long,
        cancelSignal: TransferCancelSignal?
    ): Long {
        val endInclusive = uploadOffset + sliceByteCount.toLong() - 1L
        val body = slice.toRequestBody(
            "application/octet-stream".toMediaTypeOrNull(),
            offset = sliceArrayOffset,
            byteCount = sliceByteCount
        )
        val reqBuilder = Request.Builder()
            .url(resolvedUploadUrl)
            .put(body)
            .header("Content-Range", "bytes $uploadOffset-$endInclusive/$totalBytes")
        applySdkByteRouteHeaders(reference, reqBuilder)

        val call = httpClient.newCall(reqBuilder.build())
        cancelSignal?.attach(call)
        try {
            call.execute().use { response ->
                val code = response.code
                val accepted = code == 200 || code == 308 || code == 409
                if (!accepted) {
                    throw httpStatusToStorageException(code, reference.wirePath)
                }
                return parseReceivedOffsetLong(
                    statusCode = code,
                    rangeHeader = response.header("Range"),
                    totalSize = totalBytes,
                    fallbackOffset = uploadOffset + sliceByteCount.toLong()
                )
            }
        } finally {
            cancelSignal?.detach(call)
        }
    }

    suspend fun queryHttpUploadOffset(
        reference: StorageReference,
        resolvedUploadUrl: String,
        totalBytes: Long,
        cancelSignal: TransferCancelSignal?
    ): Long {
        val emptyBody = ByteArray(0).toRequestBody("application/octet-stream".toMediaTypeOrNull())
        val reqBuilder = Request.Builder()
            .url(resolvedUploadUrl)
            .put(emptyBody)
            .header("Content-Range", "bytes */$totalBytes")
        applySdkByteRouteHeaders(reference, reqBuilder)

        val call = httpClient.newCall(reqBuilder.build())
        cancelSignal?.attach(call)
        try {
            call.execute().use { response ->
                val code = response.code
                val accepted = code == 200 || code == 308
                if (!accepted) {
                    throw httpStatusToStorageException(code, reference.wirePath)
                }
                return parseReceivedOffsetLong(
                    statusCode = code,
                    rangeHeader = response.header("Range"),
                    totalSize = totalBytes,
                    fallbackOffset = 0L
                )
            }
        } finally {
            cancelSignal?.detach(call)
        }
    }

    suspend fun downloadOverRoute(
        reference: StorageReference,
        maxAllowedBytes: Long?
    ): ByteArray {
        for (attempt in 0 until 2) {
            val meta = BridgeStorageOperations.getMetadata(reference)
            if (maxAllowedBytes != null && meta.sizeBytes > maxAllowedBytes) {
                throw BridgeStorageOperations.exceedBufferLimitException()
            }
            val resolvedUrl = buildObjectMediaUrl(reference, meta.bucket ?: reference.bucket, meta.generation)

            val reqBuilder = Request.Builder().url(resolvedUrl).get()
            applySdkByteRouteHeaders(reference, reqBuilder)

            var retryGenerationMismatch = false
            var fetchedBytes: ByteArray? = null
            httpClient.newCall(reqBuilder.build()).execute().use { response ->
                if (response.code == 412) {
                    retryGenerationMismatch = true
                } else if (!response.isSuccessful) {
                    throw httpStatusToStorageException(response.code, reference.wirePath)
                } else {
                    fetchedBytes = response.body?.bytes() ?: ByteArray(0)
                }
            }
            if (retryGenerationMismatch) {
                continue
            }
            val bytes = fetchedBytes ?: ByteArray(0)
            if (maxAllowedBytes != null && bytes.size.toLong() > maxAllowedBytes) {
                throw BridgeStorageOperations.exceedBufferLimitException()
            }
            return bytes
        }
        throw StorageException(StorageException.ERROR_RETRY_LIMIT_EXCEEDED, httpResultCode = 412)
    }

    suspend fun downloadRangeOverRoute(
        reference: StorageReference,
        bucketName: String,
        generation: String?,
        offset: Long,
        length: Int,
        cancelSignal: TransferCancelSignal?
    ): ByteArray {
        if (length <= 0) {
            return ByteArray(0)
        }
        val resolvedUrl = buildObjectMediaUrl(reference, bucketName, generation)
        val endInclusive = offset + length.toLong() - 1L
        val reqBuilder = Request.Builder()
            .url(resolvedUrl)
            .get()
            .header("Range", "bytes=$offset-$endInclusive")
        applySdkByteRouteHeaders(reference, reqBuilder)

        val call = httpClient.newCall(reqBuilder.build())
        cancelSignal?.attach(call)
        try {
            call.execute().use { response ->
                if (response.code == 412) {
                    throw StorageException(
                        StorageException.ERROR_INVALID_CHECKSUM,
                        "Object '${reference.wirePath}' changed while reading.",
                        httpResultCode = 412
                    )
                }
                if (!response.isSuccessful) {
                    throw httpStatusToStorageException(response.code, reference.wirePath)
                }
                return response.body?.bytes() ?: ByteArray(0)
            }
        } finally {
            cancelSignal?.detach(call)
        }
    }

    private fun buildObjectMediaUrl(
        reference: StorageReference,
        bucketName: String,
        generation: String?
    ): String {
        val encodedBucket = StorageUrlParser.encodeUriComponent(bucketName)
        val encodedPath = StorageUrlParser.encodeUriComponent(reference.wirePath)
        val generationQuery = if (!generation.isNullOrEmpty()) {
            "&generation=${StorageUrlParser.encodeUriComponent(generation)}"
        } else {
            ""
        }
        val relativePath = "${STORAGE_ROUTE_PREFIX}${encodedBucket}/o/${encodedPath}?alt=media$generationQuery"
        return resolveHttpUrl(reference.storage.bridgeClient.url, relativePath)
    }

    fun resolveHttpUrl(bridgeUrl: String, pathOrUrl: String): String {
        if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
            return pathOrUrl
        }
        val uri = URI.create(bridgeUrl)
        val httpScheme = when (uri.scheme?.lowercase()) {
            "wss", "https" -> "https"
            else -> "http"
        }
        val authority = uri.rawAuthority ?: "127.0.0.1:5174"
        val normalizedRel = if (pathOrUrl.startsWith("/")) pathOrUrl else "/$pathOrUrl"
        return "$httpScheme://$authority$normalizedRel"
    }

    private suspend fun applySdkByteRouteHeaders(
        reference: StorageReference,
        builder: Request.Builder
    ) {
        builder.header("x-pyric-byte-route", "1")
        val bridgeClient = reference.storage.bridgeClient
        val headerToken = bridgeClient.headers["x-pyric-session-token"]
            ?: extractQueryToken(bridgeClient.url)
        if (!headerToken.isNullOrEmpty()) {
            builder.header("x-pyric-session-token", headerToken)
        }
        val appCheckToken = try {
            reference.storage.app.appCheckTokenProvider?.invoke()
        } catch (_: Throwable) {
            null
        }
        if (!appCheckToken.isNullOrEmpty()) {
            builder.header("X-Firebase-AppCheck", appCheckToken)
        }
    }

    private fun extractQueryToken(url: String): String? {
        val query = runCatching { URI.create(url).rawQuery }.getOrNull() ?: return null
        for (pair in query.split('&')) {
            val eq = pair.indexOf('=')
            if (eq > 0) {
                val key = pair.substring(0, eq)
                if (key == "token" || key == "sessionToken") {
                    return pair.substring(eq + 1)
                }
            }
        }
        return null
    }

    private fun parseReceivedOffsetLong(
        statusCode: Int,
        rangeHeader: String?,
        totalSize: Long,
        fallbackOffset: Long
    ): Long {
        if (statusCode == 200) return totalSize
        if (rangeHeader != null) {
            val match = Regex("^bytes=0-(\\d+)$").find(rangeHeader.trim())
            if (match != null) {
                val endByte = match.groupValues[1].toLongOrNull()
                if (endByte != null) return endByte + 1L
            }
        }
        return fallbackOffset
    }

    private fun httpStatusToStorageException(statusCode: Int, path: String): StorageException {
        return when (statusCode) {
            401 -> StorageException(StorageException.ERROR_NOT_AUTHENTICATED, httpResultCode = 401)
            403 -> StorageException(StorageException.ERROR_NOT_AUTHORIZED, httpResultCode = 403)
            404 -> StorageException(
                StorageException.ERROR_OBJECT_NOT_FOUND,
                "Object '$path' does not exist.",
                httpResultCode = 404
            )
            409 -> StorageException(StorageException.ERROR_INVALID_CHECKSUM, httpResultCode = 409)
            402, 413 -> StorageException(StorageException.ERROR_QUOTA_EXCEEDED, httpResultCode = statusCode)
            503, 504 -> StorageException(StorageException.ERROR_RETRY_LIMIT_EXCEEDED, httpResultCode = statusCode)
            else -> StorageException(
                StorageException.ERROR_UNKNOWN,
                "Storage HTTP byte route returned status $statusCode for '$path'.",
                httpResultCode = statusCode
            )
        }
    }
}
