package dev.pyric.storage

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Loopback HTTP byte-route + in-memory WebSocket bridge server for deterministic unit testing
 * of `StorageByteRouteClient` HTTP headers, status-code error mapping, generation retries,
 * and binary/Unicode object transfers.
 */
class StorageLoopbackByteRouteServer {
    data class CapturedHttpRequest(
        val method: String,
        val rawPath: String,
        val rawQuery: String?,
        val headers: Map<String, String>,
        val bodyLength: Int
    )

    private class PendingUpload(
        val bucket: String,
        val path: String,
        val totalSize: Int,
        val contentType: String,
        val metadata: Map<String, Any?>,
        val buffer: ByteArrayOutputStream = ByteArrayOutputStream()
    )

    private class StoredObject(
        val bytes: ByteArray,
        val metadata: MutableMap<String, Any?>
    )

    val recordedWsOps = CopyOnWriteArrayList<Map<String, Any?>>()
    val capturedHttpRequests = CopyOnWriteArrayList<CapturedHttpRequest>()
    val queuedHttpStatuses = ConcurrentLinkedQueue<Int>()

    @Volatile
    var currentAppCheckJwt: String = "loopback-appcheck-jwt-1"

    @Volatile
    var mutateGenerationBeforeFirstHttpGet: Boolean = false

    private val transport = InMemoryBridgeTransport()
    private val clients = CopyOnWriteArrayList<PyricBridgeClient>()
    private val uploads = ConcurrentHashMap<String, PendingUpload>()
    private val objects = ConcurrentHashMap<String, StoredObject>()
    private val generationCounter = AtomicLong(500L)
    private val mintCounter = AtomicInteger(0)
    private val httpExecutor = Executors.newCachedThreadPool()
    private val httpServer: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)

    val port: Int = httpServer.address.port
    val baseHttpOrigin: String = "http://127.0.0.1:$port"

    init {
        httpServer.executor = httpExecutor
        httpServer.createContext("/__pyric/storage/v0/b/") { exchange ->
            handleHttpExchange(exchange)
        }
        httpServer.start()

        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            when (frame["type"]) {
                "attach" -> {
                    val ack = mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "clientSessionId" to ((frame["clientSessionId"] as? String) ?: "loopback-sess"),
                        "peerConnected" to true,
                        "hostInstanceId" to "loopback-host-1"
                    )
                    transport.sendToClient(JsonCodec.encodeToString(ack))
                }
                "ping" -> {
                    transport.sendToClient(
                        JsonCodec.encodeToString(mapOf("type" to "pong", "id" to frame["id"]))
                    )
                }
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    recordedWsOps.add(op)
                    handleWsOp(id, op)
                }
                "worker-sub" -> {
                    val subId = frame["subId"] as String
                    transport.sendToClient(
                        JsonCodec.encodeToString(mapOf("type" to "worker-snap", "subId" to subId, "value" to null))
                    )
                }
            }
        }
    }

    fun newBridgeClient(
        querySuffix: String = "",
        headers: Map<String, String> = emptyMap()
    ): PyricBridgeClient {
        val wsUrl = "ws://127.0.0.1:$port/__pyric/sandbox$querySuffix"
        return PyricBridgeClient(
            url = wsUrl,
            headers = headers,
            directTransport = transport
        ).also { clients.add(it) }
    }

    fun close() {
        for (client in clients) {
            runCatching { client.terminate() }
        }
        clients.clear()
        runCatching { httpServer.stop(0) }
        httpExecutor.shutdownNow()
    }

    private fun handleWsOp(id: String, op: Map<String, Any?>) {
        val method = op["method"] as? String ?: ""
        if (method == "appCheck.getToken" || method == "appCheck.getLimitedUseToken") {
            val idx = mintCounter.incrementAndGet()
            val token = "$currentAppCheckJwt-$idx"
            sendWsOk(id, mapOf("token" to token, "expireTimeMillis" to (System.currentTimeMillis() + 3_600_000L)))
            return
        }
        if (method in setOf("storage.putBytes", "storage.getBytes", "storage.putPart")) {
            sendWsErr(
                id,
                "failed-precondition",
                "This host moves Storage bytes over its HTTP byte route (/__pyric/storage/v0/...) and does not take them as frames."
            )
            return
        }
        if (method == "storage.setMetadata") {
            sendWsErr(
                id,
                "storage/unauthorized",
                "storage.setMetadata is the admin plane (firebase-admin File.setMetadata) and runs only on the admin lens."
            )
            return
        }

        val bucket = (op["bucket"] as? String)?.takeIf { it.isNotEmpty() }
            ?: (op["defaultBucket"] as? String)?.takeIf { it.isNotEmpty() }
            ?: "loopback-bucket"

        when (method) {
            "storage.beginUpload" -> {
                val path = op["path"] as? String ?: ""
                val size = (op["size"] as? Number)?.toInt() ?: 0
                @Suppress("UNCHECKED_CAST")
                val meta = (op["metadata"] as? Map<String, Any?>) ?: emptyMap()
                val contentType = (op["contentType"] as? String)
                    ?: (meta["contentType"] as? String)
                    ?: "application/octet-stream"
                val uploadId = "lb-up-${UUID.randomUUID()}"
                uploads[uploadId] = PendingUpload(bucket, path, size, contentType, meta)
                val encBucket = encodeComponent(bucket)
                val encName = URLEncoder.encode(path, StandardCharsets.UTF_8.name())
                val uploadUrl = "/__pyric/storage/v0/b/$encBucket/o?name=$encName&upload_id=$uploadId&upload_token=tok"
                sendWsOk(id, mapOf("uploadId" to uploadId, "uploadUrl" to uploadUrl))
            }
            "storage.finishUpload" -> {
                val uploadId = op["uploadId"] as? String ?: ""
                val pending = uploads.remove(uploadId)
                if (pending == null) {
                    sendWsErr(id, "storage/object-not-found", "Upload '$uploadId' not found.")
                    return
                }
                val bytes = pending.buffer.toByteArray()
                val stored = storeObject(pending.bucket, pending.path, bytes, pending.contentType, pending.metadata)
                sendWsOk(id, LinkedHashMap(stored.metadata))
            }
            "storage.abortUpload" -> {
                val uploadId = op["uploadId"] as? String ?: ""
                uploads.remove(uploadId)
                sendWsOk(id, null)
            }
            "storage.getMetadata" -> {
                val path = op["path"] as? String ?: ""
                val stored = objects["$bucket::$path"]
                if (stored == null) {
                    sendWsErr(id, "storage/object-not-found", "Object '$path' does not exist.")
                    return
                }
                sendWsOk(id, LinkedHashMap(stored.metadata))
            }
            "storage.getDownloadURL" -> {
                val path = op["path"] as? String ?: ""
                val stored = objects["$bucket::$path"]
                if (stored == null) {
                    sendWsErr(id, "storage/object-not-found", "Object '$path' does not exist.")
                    return
                }
                val token = (stored.metadata["downloadTokens"] as? String) ?: UUID.randomUUID().toString().also {
                    stored.metadata["downloadTokens"] = it
                }
                val dlPath = "/__pyric/storage/v0/b/${encodeComponent(bucket)}/o/${encodeComponent(path)}?alt=media&token=$token"
                sendWsOk(id, mapOf("path" to dlPath))
            }
            "storage.deleteObject" -> {
                val path = op["path"] as? String ?: ""
                val removed = objects.remove("$bucket::$path")
                if (removed == null) {
                    sendWsErr(id, "storage/object-not-found", "Object '$path' does not exist.")
                } else {
                    sendWsOk(id, null)
                }
            }
            else -> sendWsErr(id, "invalid-argument", "Unsupported method: $method")
        }
    }

    private fun handleHttpExchange(exchange: HttpExchange) {
        try {
            val bodyBytes = exchange.requestBody.use { it.readBytes() }
            val flatHeaders = LinkedHashMap<String, String>()
            for ((k, values) in exchange.requestHeaders) {
                if (values.isNotEmpty()) {
                    flatHeaders[k.lowercase()] = values.first()
                }
            }
            capturedHttpRequests.add(
                CapturedHttpRequest(
                    method = exchange.requestMethod,
                    rawPath = exchange.requestURI.rawPath,
                    rawQuery = exchange.requestURI.rawQuery,
                    headers = flatHeaders,
                    bodyLength = bodyBytes.size
                )
            )

            val forcedStatus = queuedHttpStatuses.poll()
            if (forcedStatus != null) {
                if (forcedStatus == 409 && exchange.requestMethod == "PUT") {
                    val uploadId = queryParam(exchange.requestURI.rawQuery, "upload_id") ?: ""
                    val pending = uploads[uploadId]
                    val received = pending?.buffer?.size() ?: 0
                    if (received > 0) {
                        exchange.responseHeaders.set("Range", "bytes=0-${received - 1}")
                    }
                }
                respondPlain(exchange, forcedStatus, "forced-$forcedStatus")
                return
            }

            val prefix = "/__pyric/storage/v0/b/"
            val rest = exchange.requestURI.rawPath.removePrefix(prefix)
            val slash = rest.indexOf('/')
            val bucket = decodeComponent(rest.substring(0, slash))
            val tail = rest.substring(slash + 1)

            if (tail == "o" && exchange.requestMethod == "PUT") {
                val uploadId = queryParam(exchange.requestURI.rawQuery, "upload_id") ?: ""
                val pending = uploads[uploadId]
                if (pending == null) {
                    respondPlain(exchange, 404, "No such upload.")
                    return
                }
                val contentRange = flatHeaders["content-range"] ?: ""
                if (!contentRange.startsWith("bytes */")) {
                    synchronized(pending) {
                        pending.buffer.write(bodyBytes)
                    }
                }
                val received = synchronized(pending) { pending.buffer.size() }
                if (received >= pending.totalSize) {
                    respondPlain(exchange, 200, "{}")
                } else {
                    if (received > 0) {
                        exchange.responseHeaders.set("Range", "bytes=0-${received - 1}")
                    }
                    exchange.sendResponseHeaders(308, -1L)
                    exchange.close()
                }
                return
            }

            if (tail.startsWith("o/") && exchange.requestMethod == "GET") {
                val objectPath = decodeComponent(tail.removePrefix("o/"))
                val stored = objects["$bucket::$objectPath"]
                if (stored == null) {
                    respondPlain(exchange, 404, "No such object.")
                    return
                }
                if (mutateGenerationBeforeFirstHttpGet) {
                    mutateGenerationBeforeFirstHttpGet = false
                    stored.metadata["generation"] = generationCounter.incrementAndGet().toString()
                }
                val pinnedGen = queryParam(exchange.requestURI.rawQuery, "generation")
                if (pinnedGen != null && pinnedGen != stored.metadata["generation"]) {
                    respondPlain(exchange, 412, "Generation changed.")
                    return
                }
                val rangeHeader = flatHeaders["range"]
                if (rangeHeader != null && rangeHeader.startsWith("bytes=")) {
                    val parts = rangeHeader.removePrefix("bytes=").split('-')
                    val start = parts[0].toInt()
                    val end = minOf(parts[1].toInt(), stored.bytes.size - 1)
                    val slice = if (stored.bytes.isEmpty() || start >= stored.bytes.size) {
                        ByteArray(0)
                    } else {
                        stored.bytes.copyOfRange(start, end + 1)
                    }
                    exchange.responseHeaders.set("Content-Range", "bytes $start-$end/${stored.bytes.size}")
                    sendBytesResponse(exchange, 206, slice)
                    return
                }
                sendBytesResponse(exchange, 200, stored.bytes)
                return
            }

            respondPlain(exchange, 404, "Unknown route")
        } catch (t: Throwable) {
            runCatching { respondPlain(exchange, 500, t.message ?: "error") }
        }
    }

    private fun storeObject(
        bucket: String,
        path: String,
        bytes: ByteArray,
        contentType: String,
        metaIn: Map<String, Any?>
    ): StoredObject {
        val md5 = Base64.getEncoder().encodeToString(MessageDigest.getInstance("MD5").digest(bytes))
        val gen = generationCounter.incrementAndGet().toString()
        val nowIso = Instant.ofEpochMilli(1_770_000_000_000L + gen.toLong() * 1000L).toString()
        val meta = LinkedHashMap<String, Any?>()
        meta["bucket"] = bucket
        meta["fullPath"] = path
        meta["name"] = path.substringAfterLast('/')
        meta["size"] = bytes.size
        meta["generation"] = gen
        meta["metageneration"] = "1"
        meta["timeCreated"] = nowIso
        meta["updated"] = nowIso
        meta["md5Hash"] = md5
        meta["contentType"] = contentType
        (metaIn["cacheControl"] as? String)?.let { meta["cacheControl"] = it }
        @Suppress("UNCHECKED_CAST")
        (metaIn["customMetadata"] as? Map<String, Any?>)?.let { custom ->
            val clean = LinkedHashMap<String, String>()
            for ((k, v) in custom) {
                if (v != null) clean[k] = v.toString()
            }
            if (clean.isNotEmpty()) meta["customMetadata"] = clean
        }
        return StoredObject(bytes.copyOf(), meta).also { objects["$bucket::$path"] = it }
    }

    private fun sendWsOk(id: String, value: Any?) {
        transport.sendToClient(
            JsonCodec.encodeToString(mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to value))
        )
    }

    private fun sendWsErr(id: String, code: String, message: String) {
        transport.sendToClient(
            JsonCodec.encodeToString(
                mapOf("type" to "worker-res", "id" to id, "ok" to false, "error" to mapOf("code" to code, "message" to message))
            )
        )
    }

    private fun respondPlain(exchange: HttpExchange, status: Int, body: String) {
        sendBytesResponse(exchange, status, body.toByteArray(StandardCharsets.UTF_8))
    }

    private fun sendBytesResponse(exchange: HttpExchange, status: Int, bytes: ByteArray) {
        if (bytes.isEmpty()) {
            exchange.responseHeaders.set("Content-Length", "0")
            exchange.sendResponseHeaders(status, -1L)
            exchange.close()
        } else {
            exchange.sendResponseHeaders(status, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
    }
}

private fun encodeComponent(value: String): String =
    URLEncoder.encode(value, StandardCharsets.UTF_8.name())
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%7E", "~")

private fun decodeComponent(encoded: String): String =
    URLDecoder.decode(encoded.replace("+", "%2B"), StandardCharsets.UTF_8.name())

private fun queryParam(rawQuery: String?, key: String): String? {
    if (rawQuery.isNullOrEmpty()) return null
    for (pair in rawQuery.split('&')) {
        val eq = pair.indexOf('=')
        if (eq > 0 && decodeComponent(pair.substring(0, eq)) == key) {
            return decodeComponent(pair.substring(eq + 1))
        }
    }
    return null
}
