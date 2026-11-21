package dev.pyric.storage

import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicLong

/**
 * In-memory mock Pyric Storage + Auth bridge harness for unit testing `com.google.firebase.storage`
 * wire framing, bucket routing, metadata patches, chunked transfers, and error mapping.
 */
class StorageMockBridgeHarness(
    var requireAuthenticated: Boolean = false
) {
    data class StoredEntry(
        var bytes: ByteArray,
        var metadata: MutableMap<String, Any?>
    )

    private class StagedUpload(
        val bucketKey: String,
        val bucketDisplayName: String,
        val path: String,
        val declaredSize: Int,
        val contentType: String,
        val metadata: Map<String, Any?>,
        val parts: ConcurrentHashMap<Int, ByteArray> = ConcurrentHashMap()
    )

    val transport = InMemoryBridgeTransport()
    val recordedOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val createdClients = CopyOnWriteArrayList<PyricBridgeClient>()

    var nextForcedError: Pair<String, String>? = null
    var forceSingleShotPayloadTooLargeAboveBytes: Int = 8 * 1024 * 1024
    var restrictSetMetadataToAdmin: Boolean = false

    private val generationSeq = AtomicLong(1000L)
    private val clockMillis = AtomicLong(1_770_000_000_000L)
    private val objectsByBucket = ConcurrentHashMap<String, ConcurrentHashMap<String, StoredEntry>>()
    private val stagedUploads = ConcurrentHashMap<String, StagedUpload>()
    private var defaultBucketAlias: String? = null

    init {
        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            when (frame["type"]) {
                "attach" -> {
                    val sessionId = (frame["clientSessionId"] as? String) ?: "mock-storage-session"
                    val ack = mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "clientSessionId" to sessionId,
                        "peerConnected" to true,
                        "hostInstanceId" to "mock-storage-host-1"
                    )
                    transport.sendToClient(JsonCodec.encodeToString(ack))
                }
                "ping" -> {
                    val pong = mapOf("type" to "pong", "id" to frame["id"])
                    transport.sendToClient(JsonCodec.encodeToString(pong))
                }
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    recordedOps.add(op)
                    handleWorkerOp(id, op)
                }
                "worker-sub" -> {
                    val subId = frame["subId"] as String
                    val snap = mapOf("type" to "worker-snap", "subId" to subId, "value" to null)
                    transport.sendToClient(JsonCodec.encodeToString(snap))
                }
            }
        }
    }

    fun newBridgeClient(): PyricBridgeClient =
        PyricBridgeClient(transport).also { createdClients.add(it) }

    fun closeAll() {
        for (client in createdClients) {
            runCatching { client.terminate() }
        }
        createdClients.clear()
    }

    private fun sendOk(id: String, value: Any?) {
        val reply = mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to value)
        transport.sendToClient(JsonCodec.encodeToString(reply))
    }

    private fun sendErr(id: String, code: String, message: String) {
        val reply = mapOf(
            "type" to "worker-res",
            "id" to id,
            "ok" to false,
            "error" to mapOf("code" to code, "message" to message)
        )
        transport.sendToClient(JsonCodec.encodeToString(reply))
    }

    private fun resolveBuckets(op: Map<String, Any?>): Pair<String, String> {
        val rawDefault = (op["defaultBucket"] as? String)?.takeIf { it.isNotEmpty() }
        if (rawDefault != null && defaultBucketAlias == null) {
            defaultBucketAlias = rawDefault
        }
        val explicitBucket = (op["bucket"] as? String)?.takeIf { it.isNotEmpty() }
        val storeKey = if (explicitBucket == null || explicitBucket == defaultBucketAlias) {
            "pyric-default"
        } else {
            explicitBucket
        }
        val displayBucket = explicitBucket ?: rawDefault ?: defaultBucketAlias ?: "pyric-default"
        return storeKey to displayBucket
    }

    private fun isCallerAuthenticated(op: Map<String, Any?>): Boolean {
        @Suppress("UNCHECKED_CAST")
        val actAs = op["actAs"] as? Map<String, Any?> ?: return false
        return when (actAs["mode"]) {
            "admin" -> true
            "as" -> !(actAs["uid"] as? String).isNullOrEmpty()
            else -> false
        }
    }

    private fun handleWorkerOp(id: String, op: Map<String, Any?>) {
        val forced = nextForcedError
        if (forced != null) {
            nextForcedError = null
            sendErr(id, forced.first, forced.second)
            return
        }

        val method = op["method"] as? String ?: ""
        if (method == "auth.createUser" || method == "auth.signInEmail") {
            val email = (op["email"] as? String) ?: "user@example.com"
            val uid = "uid-${email.substringBefore('@')}"
            sendOk(
                id,
                mapOf(
                    "user" to mapOf("uid" to uid, "email" to email, "emailVerified" to false),
                    "operationType" to "signIn"
                )
            )
            return
        }
        if (method == "auth.getIdTokenResult") {
            sendOk(id, mapOf("claims" to emptyMap<String, Any?>(), "signInProvider" to "password"))
            return
        }
        if (method == "auth.signOut") {
            sendOk(id, null)
            return
        }
        if (method == "appCheck.getToken" || method == "appCheck.getLimitedUseToken") {
            sendOk(
                id,
                mapOf(
                    "token" to "mock-app-check-jwt",
                    "expireTimeMillis" to (System.currentTimeMillis() + 3_600_000L)
                )
            )
            return
        }

        if (requireAuthenticated && !isCallerAuthenticated(op) && method != "storage.abortUpload") {
            sendErr(id, "storage/unauthorized", "storage/unauthorized: Operation '$method' denied by rules.")
            return
        }

        when (method) {
            "storage.putBytes" -> {
                val (storeKey, displayBucket) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val bytes = Base64.getDecoder().decode((op["dataB64"] as? String) ?: "")
                @Suppress("UNCHECKED_CAST")
                val metaIn = (op["metadata"] as? Map<String, Any?>) ?: emptyMap()
                val contentType = (op["contentType"] as? String)
                    ?: (metaIn["contentType"] as? String)
                    ?: "application/octet-stream"
                val stored = writeObject(storeKey, displayBucket, path, bytes, contentType, metaIn)
                sendOk(id, stored.metadata)
            }
            "storage.beginUpload" -> {
                val (storeKey, displayBucket) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val size = (op["size"] as? Number)?.toInt() ?: 0
                @Suppress("UNCHECKED_CAST")
                val metaIn = (op["metadata"] as? Map<String, Any?>) ?: emptyMap()
                val contentType = (op["contentType"] as? String)
                    ?: (metaIn["contentType"] as? String)
                    ?: "application/octet-stream"
                val uploadId = "up-${UUID.randomUUID()}"
                stagedUploads[uploadId] = StagedUpload(storeKey, displayBucket, path, size, contentType, metaIn)
                sendOk(
                    id,
                    mapOf(
                        "uploadId" to uploadId,
                        "uploadUrl" to buildMockUploadRouteUrl(storeKey, path, uploadId)
                    )
                )
            }
            "storage.putPart" -> {
                val uploadId = op["uploadId"] as? String ?: ""
                val partIndex = (op["partIndex"] as? Number)?.toInt() ?: 0
                val staged = stagedUploads[uploadId]
                if (staged == null) {
                    sendErr(id, "storage/object-not-found", "Upload '$uploadId' not found.")
                    return
                }
                val partBytes = Base64.getDecoder().decode((op["dataB64"] as? String) ?: "")
                staged.parts[partIndex] = partBytes
                sendOk(id, mapOf("bytesTransferred" to partBytes.size))
            }
            "storage.finishUpload" -> {
                val uploadId = op["uploadId"] as? String ?: ""
                val staged = stagedUploads.remove(uploadId)
                if (staged == null) {
                    sendErr(id, "storage/object-not-found", "Upload '$uploadId' not found.")
                    return
                }
                val ordered = staged.parts.entries.sortedBy { it.key }.map { it.value }
                val total = ordered.sumOf { it.size }
                val combined = ByteArray(total)
                var pos = 0
                for (chunk in ordered) {
                    System.arraycopy(chunk, 0, combined, pos, chunk.size)
                    pos += chunk.size
                }
                val stored = writeObject(
                    staged.bucketKey,
                    staged.bucketDisplayName,
                    staged.path,
                    combined,
                    staged.contentType,
                    staged.metadata
                )
                sendOk(id, stored.metadata)
            }
            "storage.abortUpload" -> {
                val uploadId = op["uploadId"] as? String ?: ""
                stagedUploads.remove(uploadId)
                sendOk(id, null)
            }
            "storage.getMetadata" -> {
                val (storeKey, displayBucket) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val entry = objectsByBucket[storeKey]?.get(path)
                if (entry == null) {
                    sendErr(id, "storage/object-not-found", "storage/object-not-found: no object at \"$path\".")
                    return
                }
                val copy = LinkedHashMap(entry.metadata)
                copy["bucket"] = displayBucket
                sendOk(id, copy)
            }
            "storage.setMetadata" -> {
                if (restrictSetMetadataToAdmin) {
                    @Suppress("UNCHECKED_CAST")
                    val actAs = op["actAs"] as? Map<String, Any?>
                    if (actAs?.get("mode") != "admin") {
                        sendErr(
                            id,
                            "storage/unauthorized",
                            "storage.setMetadata is the admin plane (firebase-admin File.setMetadata) and runs only on the admin lens."
                        )
                        return
                    }
                }
                val (storeKey, displayBucket) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val entry = objectsByBucket[storeKey]?.get(path)
                if (entry == null) {
                    sendErr(id, "storage/object-not-found", "storage/object-not-found: no object at \"$path\".")
                    return
                }
                @Suppress("UNCHECKED_CAST")
                val patch = (op["patch"] as? Map<String, Any?>) ?: emptyMap()
                applyPatch(entry.metadata, patch)
                val copy = LinkedHashMap(entry.metadata)
                copy["bucket"] = displayBucket
                sendOk(id, copy)
            }
            "storage.getBytes" -> {
                val (storeKey, _) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val entry = objectsByBucket[storeKey]?.get(path)
                if (entry == null) {
                    sendErr(id, "storage/object-not-found", "storage/object-not-found: no object at \"$path\".")
                    return
                }
                val offset = (op["offset"] as? Number)?.toInt()
                val length = (op["length"] as? Number)?.toInt()
                if (offset == null && length == null && entry.bytes.size > forceSingleShotPayloadTooLargeAboveBytes) {
                    sendErr(id, "payload-too-large", "Object '$path' exceeds single-frame limit.")
                    return
                }
                val slice = if (offset != null || length != null) {
                    val start = offset ?: 0
                    val end = minOf(start + (length ?: (entry.bytes.size - start)), entry.bytes.size)
                    entry.bytes.copyOfRange(start, end)
                } else {
                    entry.bytes
                }
                sendOk(
                    id,
                    mapOf(
                        "dataB64" to Base64.getEncoder().encodeToString(slice),
                        "contentType" to entry.metadata["contentType"],
                        "size" to slice.size,
                        "generation" to entry.metadata["generation"]
                    )
                )
            }
            "storage.getDownloadURL" -> {
                val (storeKey, displayBucket) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val entry = objectsByBucket[storeKey]?.get(path)
                if (entry == null) {
                    sendErr(id, "storage/object-not-found", "storage/object-not-found: no object at \"$path\".")
                    return
                }
                val token = (entry.metadata["downloadTokens"] as? String) ?: UUID.randomUUID().toString().also {
                    entry.metadata["downloadTokens"] = it
                }
                sendOk(id, mapOf("path" to buildMockDownloadRouteUrl(displayBucket, path, token)))
            }
            "storage.deleteObject" -> {
                val (storeKey, _) = resolveBuckets(op)
                val path = op["path"] as? String ?: ""
                val removed = objectsByBucket[storeKey]?.remove(path)
                if (removed == null) {
                    sendErr(id, "storage/object-not-found", "storage/object-not-found: no object at \"$path\".")
                    return
                }
                sendOk(id, null)
            }
            "storage.listAll" -> {
                val (storeKey, _) = resolveBuckets(op)
                val prefixPath = op["path"] as? String ?: ""
                val scanPrefix = if (prefixPath.isEmpty()) "" else "$prefixPath/"
                val bucketMap = objectsByBucket[storeKey] ?: emptyMap()
                val sortedKeys = bucketMap.keys.filter { it.startsWith(scanPrefix) }.sorted()

                val items = ArrayList<Map<String, String>>()
                val seenFolders = LinkedHashSet<String>()
                for (fullPath in sortedKeys) {
                    val rel = fullPath.removePrefix(scanPrefix)
                    if (rel.isEmpty()) continue
                    val slashIdx = rel.indexOf('/')
                    if (slashIdx == -1) {
                        items.add(mapOf("fullPath" to fullPath, "name" to rel))
                    } else {
                        val folderName = rel.substring(0, slashIdx)
                        val folderFullPath = "$scanPrefix$folderName"
                        seenFolders.add(folderFullPath)
                    }
                }
                val prefixes = seenFolders
                    .sortedBy { "$it/" }
                    .map { folderPath ->
                        val name = folderPath.substringAfterLast('/')
                        mapOf("fullPath" to folderPath, "name" to name)
                    }
                sendOk(id, mapOf("items" to items, "prefixes" to prefixes))
            }
            else -> sendErr(id, "invalid-argument", "Unknown method: $method")
        }
    }

    private fun writeObject(
        storeKey: String,
        displayBucket: String,
        path: String,
        bytes: ByteArray,
        contentType: String,
        metaIn: Map<String, Any?>
    ): StoredEntry {
        val entry = buildMockStoredEntry(
            displayBucket = displayBucket,
            path = path,
            bytes = bytes,
            contentType = contentType,
            metaIn = metaIn,
            nowIso = Instant.ofEpochMilli(clockMillis.addAndGet(1000L)).toString(),
            generation = generationSeq.incrementAndGet().toString()
        )
        objectsByBucket.computeIfAbsent(storeKey) { ConcurrentHashMap() }[path] = entry
        return entry
    }

    private fun applyPatch(target: MutableMap<String, Any?>, patch: Map<String, Any?>) {
        applyMockMetadataPatch(
            target = target,
            patch = patch,
            nowIso = Instant.ofEpochMilli(clockMillis.addAndGet(1000L)).toString()
        )
    }
}

private fun encodeMockUriComponent(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%7E", "~")

private fun buildMockUploadRouteUrl(bucketKey: String, path: String, uploadId: String): String {
    val encodedBucket = encodeMockUriComponent(bucketKey)
    val encodedName = URLEncoder.encode(path, StandardCharsets.UTF_8.name())
    val encodedId = URLEncoder.encode(uploadId, StandardCharsets.UTF_8.name())
    return "/__pyric/storage/v0/b/$encodedBucket/o?name=$encodedName&upload_id=$encodedId&upload_token=tok"
}

private fun buildMockDownloadRouteUrl(displayBucket: String, path: String, token: String): String {
    val encodedBucket = encodeMockUriComponent(displayBucket)
    val encodedPath = encodeMockUriComponent(path)
    val encodedToken = encodeMockUriComponent(token)
    return "/__pyric/storage/v0/b/$encodedBucket/o/$encodedPath?alt=media&token=$encodedToken"
}

private fun buildMockStoredEntry(
    displayBucket: String,
    path: String,
    bytes: ByteArray,
    contentType: String,
    metaIn: Map<String, Any?>,
    nowIso: String,
    generation: String
): StorageMockBridgeHarness.StoredEntry {
    val md5 = Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes))
    val storedMeta = LinkedHashMap<String, Any?>()
    storedMeta["bucket"] = displayBucket
    storedMeta["fullPath"] = path
    storedMeta["name"] = path.substringAfterLast('/')
    storedMeta["size"] = bytes.size
    storedMeta["generation"] = generation
    storedMeta["metageneration"] = "1"
    storedMeta["timeCreated"] = nowIso
    storedMeta["updated"] = nowIso
    storedMeta["md5Hash"] = md5
    storedMeta["contentType"] = contentType
    storedMeta["contentEncoding"] = (metaIn["contentEncoding"] as? String) ?: "identity"
    (metaIn["cacheControl"] as? String)?.let { storedMeta["cacheControl"] = it }
    (metaIn["contentDisposition"] as? String)?.let { storedMeta["contentDisposition"] = it }
    (metaIn["contentLanguage"] as? String)?.let { storedMeta["contentLanguage"] = it }

    @Suppress("UNCHECKED_CAST")
    val customIn = metaIn["customMetadata"] as? Map<String, Any?>
    if (customIn != null && customIn.isNotEmpty()) {
        val cleanCustom = LinkedHashMap<String, String>()
        for ((k, v) in customIn) {
            if (v != null) cleanCustom[k] = v.toString()
        }
        if (cleanCustom.isNotEmpty()) {
            storedMeta["customMetadata"] = cleanCustom
        }
    }
    return StorageMockBridgeHarness.StoredEntry(bytes.copyOf(), storedMeta)
}

private fun applyMockMetadataPatch(
    target: MutableMap<String, Any?>,
    patch: Map<String, Any?>,
    nowIso: String
) {
    val currentMetaGen = (target["metageneration"] as? String)?.toLongOrNull() ?: 1L
    target["metageneration"] = (currentMetaGen + 1L).toString()
    target["updated"] = nowIso

    @Suppress("UNCHECKED_CAST")
    val settable = patch["settable"] as? Map<String, Any?>
    if (settable != null) {
        for (field in listOf("contentType", "cacheControl", "contentDisposition", "contentEncoding", "contentLanguage")) {
            if (settable.containsKey(field)) {
                val value = settable[field]
                if (value == null) target.remove(field) else target[field] = value
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    val customPatch = patch["customMetadata"] as? Map<String, Any?>
    if (customPatch != null) {
        @Suppress("UNCHECKED_CAST")
        val merged = LinkedHashMap((target["customMetadata"] as? Map<String, String>) ?: emptyMap())
        for ((k, v) in customPatch) {
            if (v == null) merged.remove(k) else merged[k] = v.toString()
        }
        if (merged.isEmpty()) target.remove("customMetadata") else target["customMetadata"] = merged
    }
}
