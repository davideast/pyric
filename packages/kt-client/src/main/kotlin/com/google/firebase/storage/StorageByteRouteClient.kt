package com.google.firebase.storage

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.PyricBridgeClient
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.net.URI
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.TimeUnit

/**
 * HTTP byte-route transfer collaborator for hosts that advertise `storageByteRoute`
 * (`/__pyric/storage/v0/b/<bucket>/o/...`), mirroring `storage-byte-route.ts`.
 */
internal object StorageByteRouteClient {
    private const val STORAGE_ROUTE_PREFIX: String = "/__pyric/storage/v0/b/"

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
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
            val body = bytes.toRequestBody(
                "application/octet-stream".toMediaTypeOrNull(),
                offset = offset,
                byteCount = sliceLen
            )
            val reqBuilder = Request.Builder()
                .url(resolvedUrl)
                .put(body)
                .header("Content-Range", "bytes $offset-${endExclusive - 1}/$total")
            applySdkByteRouteHeaders(reference, reqBuilder)

            httpClient.newCall(reqBuilder.build()).execute().use { response ->
                val code = response.code
                val accepted = code == 200 || code == 308 || code == 409
                if (!accepted) {
                    throw httpStatusToStorageException(code, reference.wirePath)
                }
                offset = parseReceivedOffset(code, response.header("Range"), total, endExclusive)
                onProgress?.invoke(offset.toLong())
            }
        }
        val finishRes = reference.storage.bridgeClient.op(
            method = "storage.finishUpload",
            params = mapOf("uploadId" to uploadId),
            actAs = reference.storage.getEffectiveAuthLens().toMap(),
            timeoutMs = reference.storage.maxUploadRetryTimeMillis.coerceAtLeast(1_000L)
        )
        return BridgeStorageOperations.parseMetadataReply(finishRes, reference)
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
            val bucketName = meta.bucket ?: reference.bucket
            val encodedBucket = StorageUrlParser.encodeUriComponent(bucketName)
            val encodedPath = StorageUrlParser.encodeUriComponent(reference.wirePath)
            val gen = meta.generation
            val generationQuery = if (!gen.isNullOrEmpty()) {
                "&generation=${StorageUrlParser.encodeUriComponent(gen)}"
            } else {
                ""
            }
            val relativePath = "${STORAGE_ROUTE_PREFIX}${encodedBucket}/o/${encodedPath}?alt=media$generationQuery"
            val resolvedUrl = resolveHttpUrl(reference.storage.bridgeClient.url, relativePath)

            val reqBuilder = Request.Builder().url(resolvedUrl).get()
            applySdkByteRouteHeaders(reference, reqBuilder)

            var retryGenerationMismatch = false
            var fetchedBytes: ByteArray? = null
            httpClient.newCall(reqBuilder.build()).execute().use { response ->
                if (response.code == 412 && attempt == 0) {
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
        throw StorageException(StorageException.ERROR_RETRY_LIMIT_EXCEEDED)
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

    private fun parseReceivedOffset(
        statusCode: Int,
        rangeHeader: String?,
        totalSize: Int,
        fallbackOffset: Int
    ): Int {
        if (statusCode == 200) return totalSize
        if (rangeHeader != null) {
            val match = Regex("^bytes=0-(\\d+)$").find(rangeHeader.trim())
            if (match != null) {
                val endByte = match.groupValues[1].toIntOrNull()
                if (endByte != null) return endByte + 1
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
            413 -> StorageException(StorageException.ERROR_QUOTA_EXCEEDED, httpResultCode = 413)
            else -> StorageException(
                StorageException.ERROR_UNKNOWN,
                "Storage HTTP byte route returned status $statusCode for '$path'.",
                httpResultCode = statusCode
            )
        }
    }
}
