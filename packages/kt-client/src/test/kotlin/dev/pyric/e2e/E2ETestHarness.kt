package dev.pyric.e2e

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import dev.pyric.codecs.ValueCodec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * End-to-End Test Harness maintaining genuine in-memory document state,
 * handling bridge protocol frames over InMemoryBridgeTransport, and dispatching
 * real-time snapshots to active subscribers.
 */
class E2ETestHarness {

    data class Subscription(
        val subId: String,
        val target: Map<String, Any?>,
        val transport: InMemoryBridgeTransport
    )

    val store = ConcurrentHashMap<String, MutableMap<String, Any?>>()
    private val storeLock = Any()
    val subscriptions = CopyOnWriteArrayList<Subscription>()
    val recordedOperations = CopyOnWriteArrayList<Map<String, Any?>>()
    val conflictCountdown = AtomicInteger(0)
    val transactionAttemptCount = AtomicInteger(0)

    fun createClient(appName: String = "e2e-app", databaseId: String = "(default)"): FirebaseFirestore {
        val transport = InMemoryBridgeTransport()
        val bridgeClient = PyricBridgeClient(transport)

        val app = try {
            FirebaseApp.getInstance(appName)
        } catch (_: Exception) {
            FirebaseApp.initializeApp(
                appName,
                FirebaseOptions.Builder()
                    .setProjectId("e2e-project")
                    .setApiKey("e2e-key")
                    .setApplicationId("e2e-app-id")
                    .build()
            )
        }

        transport.onServerReceive { jsonStr ->
            handleClientMessage(jsonStr, transport)
        }

        return FirebaseFirestore(bridgeClient, app, databaseId)
    }

    private fun handleClientMessage(jsonStr: String, transport: InMemoryBridgeTransport) {
        val msg = JsonCodec.decodeMap(jsonStr)
        val type = msg["type"] as? String

        when (type) {
            "attach" -> {
                transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            }
            "worker-op" -> {
                val id = msg["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = msg["op"] as Map<String, Any?>
                recordedOperations.add(op)
                handleWorkerOp(id, op, transport)
            }
            "worker-sub" -> {
                val subId = msg["subId"] as String
                @Suppress("UNCHECKED_CAST")
                val sub = msg["sub"] as Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val target = sub["target"] as Map<String, Any?>
                val subscription = Subscription(subId, target, transport)
                synchronized(storeLock) {
                    subscriptions.add(subscription)
                    emitSnapshot(subscription)
                }
            }
            "worker-unsub" -> {
                val subId = msg["subId"] as String
                synchronized(storeLock) {
                    subscriptions.removeIf { it.subId == subId }
                }
            }
        }
    }

    private fun handleWorkerOp(id: String, op: Map<String, Any?>, transport: InMemoryBridgeTransport) {
        val method = op["method"] as String

        when (method) {
            "getDoc" -> {
                val path = op["path"] as String
                val (exists, encoded) = synchronized(storeLock) {
                    val data = store[path]
                    if (data != null) {
                        true to encodeDocData(data)
                    } else {
                        false to null
                    }
                }
                val idPart = path.substringAfterLast('/')
                if (exists) {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "id" to idPart,
                                    "path" to path,
                                    "exists" to true,
                                    "data" to mapOf("json" to JsonCodec.encodeToString(encoded))
                                )
                            )
                        )
                    )
                } else {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "id" to idPart,
                                    "path" to path,
                                    "exists" to false,
                                    "data" to null
                                )
                            )
                        )
                    )
                }
            }
            "setDoc" -> {
                val path = op["path"] as String
                @Suppress("UNCHECKED_CAST")
                val rawData = (op["data"] as? Map<String, Any?>) ?: emptyMap()
                val merge = op["merge"] == true
                synchronized(storeLock) {
                    applySet(path, rawData, merge)
                    notifySubscribers(path)
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
            "updateDoc" -> {
                val path = op["path"] as String
                val notFound = synchronized(storeLock) {
                    if (!store.containsKey(path)) {
                        true
                    } else {
                        @Suppress("UNCHECKED_CAST")
                        val rawData = (op["data"] as? Map<String, Any?>) ?: emptyMap()
                        applyUpdate(path, rawData)
                        notifySubscribers(path)
                        false
                    }
                }
                if (notFound) {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf("code" to "NOT_FOUND", "message" to "No document to update: $path")
                            )
                        )
                    )
                    return
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
            "deleteDoc" -> {
                val path = op["path"] as String
                synchronized(storeLock) {
                    store.remove(path)
                    notifySubscribers(path)
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
            "getDocs" -> {
                @Suppress("UNCHECKED_CAST")
                val target = op["target"] as Map<String, Any?>
                val docPayloads = synchronized(storeLock) {
                    val docs = queryDocs(target)
                    docs.map { doc ->
                        mapOf(
                            "id" to doc.id,
                            "path" to doc.path,
                            "exists" to true,
                            "data" to mapOf("json" to JsonCodec.encodeToString(encodeDocData(doc.data)))
                        )
                    }
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf("docs" to docPayloads)
                        )
                    )
                )
            }
            "batchCommit" -> {
                @Suppress("UNCHECKED_CAST")
                val writes = (op["writes"] as? List<Map<String, Any?>>) ?: emptyList()
                synchronized(storeLock) {
                    val touchedPaths = mutableSetOf<String>()
                    for (w in writes) {
                        val path = w["path"] as String
                        touchedPaths.add(path)
                        when (w["op"] as? String) {
                            "set" -> {
                                @Suppress("UNCHECKED_CAST")
                                val rawData = (w["data"] as? Map<String, Any?>) ?: emptyMap()
                                val merge = w["merge"] == true
                                applySet(path, rawData, merge)
                            }
                            "update" -> {
                                @Suppress("UNCHECKED_CAST")
                                val rawData = (w["data"] as? Map<String, Any?>) ?: emptyMap()
                                applyUpdate(path, rawData)
                            }
                            "delete" -> {
                                store.remove(path)
                            }
                        }
                    }
                    touchedPaths.forEach { notifySubscribers(it) }
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
            "txnCommit" -> {
                transactionAttemptCount.incrementAndGet()
                if (conflictCountdown.get() > 0) {
                    conflictCountdown.decrementAndGet()
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf("code" to "ABORTED", "message" to "Transaction conflict")
                            )
                        )
                    )
                    return
                }

                @Suppress("UNCHECKED_CAST")
                val writes = (op["writes"] as? List<Map<String, Any?>>) ?: emptyList()
                synchronized(storeLock) {
                    val touchedPaths = mutableSetOf<String>()
                    for (w in writes) {
                        val path = w["path"] as String
                        touchedPaths.add(path)
                        when (w["op"] as? String) {
                            "set" -> {
                                @Suppress("UNCHECKED_CAST")
                                val rawData = (w["data"] as? Map<String, Any?>) ?: emptyMap()
                                val merge = w["merge"] == true
                                applySet(path, rawData, merge)
                            }
                            "update" -> {
                                @Suppress("UNCHECKED_CAST")
                                val rawData = (w["data"] as? Map<String, Any?>) ?: emptyMap()
                                applyUpdate(path, rawData)
                            }
                            "delete" -> {
                                store.remove(path)
                            }
                        }
                    }
                    touchedPaths.forEach { notifySubscribers(it) }
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
            "count" -> {
                @Suppress("UNCHECKED_CAST")
                val target = op["target"] as Map<String, Any?>
                val count = synchronized(storeLock) {
                    queryDocs(target).size
                }
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf("count" to count)
                        )
                    )
                )
            }
            else -> {
                transport.sendToClient(
                    JsonCodec.encodeToString(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                    )
                )
            }
        }
    }

    private fun applySet(path: String, rawData: Map<String, Any?>, merge: Boolean) {
        val existing = if (merge) store[path] ?: mutableMapOf() else mutableMapOf()
        val decoded = resolveSentinelsAndDecode(rawData, existing)
        if (merge) {
            existing.putAll(decoded)
            store[path] = existing
        } else {
            store[path] = decoded.toMutableMap()
        }
    }

    private fun applyUpdate(path: String, rawData: Map<String, Any?>) {
        val existing = store.computeIfAbsent(path) { mutableMapOf() }
        val decoded = resolveSentinelsAndDecode(rawData, existing)
        for ((k, v) in decoded) {
            if (k.contains('.')) {
                applyDotPath(existing, k, v)
            } else {
                existing[k] = v
            }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun applyDotPath(root: MutableMap<String, Any?>, path: String, value: Any?) {
        val parts = path.split('.')
        var curr = root
        for (i in 0 until parts.size - 1) {
            val part = parts[i]
            val next = curr[part]
            if (next is MutableMap<*, *>) {
                curr = next as MutableMap<String, Any?>
            } else {
                val newMap = mutableMapOf<String, Any?>()
                curr[part] = newMap
                curr = newMap
            }
        }
        val last = parts.last()
        if (value == SENTINEL_DELETE) {
            curr.remove(last)
        } else {
            curr[last] = value
        }
    }

    private fun resolveSentinelsAndDecode(
        rawData: Map<String, Any?>,
        existing: MutableMap<String, Any?>
    ): Map<String, Any?> {
        val result = mutableMapOf<String, Any?>()
        for ((k, rawV) in rawData) {
            val resolved = resolveValue(rawV, existing[k])
            if (resolved === SENTINEL_DELETE) {
                if (k.contains('.')) {
                    applyDotPath(existing, k, SENTINEL_DELETE)
                } else {
                    existing.remove(k)
                }
            } else {
                result[k] = resolved
            }
        }
        return result
    }

    @Suppress("UNCHECKED_CAST")
    private fun resolveValue(rawVal: Any?, existingVal: Any?): Any? {
        if (rawVal is Map<*, *>) {
            val map = rawVal as Map<String, Any?>
            val sentinel = map["__sentinel"] as? String
            if (sentinel != null) {
                return when (sentinel) {
                    "serverTimestamp" -> Timestamp.now()
                    "deleteField" -> SENTINEL_DELETE
                    "increment" -> {
                        val operand = (map["n"] as Number).toDouble()
                        val current = (existingVal as? Number)?.toDouble() ?: 0.0
                        val res = current + operand
                        if (res % 1.0 == 0.0) res.toLong() else res
                    }
                    "arrayUnion" -> {
                        val elements = (map["values"] as? List<Any?>) ?: emptyList()
                        val existingList = (existingVal as? List<Any?>)?.toMutableList() ?: mutableListOf()
                        for (el in elements) {
                            val decoded = ValueCodec.decodeValue(el)
                            if (!existingList.contains(decoded)) {
                                existingList.add(decoded)
                            }
                        }
                        existingList
                    }
                    "arrayRemove" -> {
                        val elements = (map["values"] as? List<Any?>) ?: emptyList()
                        val existingList = (existingVal as? List<Any?>)?.toMutableList() ?: mutableListOf()
                        val decodedToRemove = elements.map { ValueCodec.decodeValue(it) }.toSet()
                        existingList.filter { it !in decodedToRemove }
                    }
                    else -> ValueCodec.decodeValue(rawVal)
                }
            }
            return ValueCodec.decodeValue(rawVal)
        }
        return ValueCodec.decodeValue(rawVal)
    }

    private fun encodeDocData(data: Map<String, Any?>): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return (ValueCodec.encodeValue(data) as? Map<String, Any?>) ?: emptyMap()
    }

    private fun queryDocs(target: Map<String, Any?>): List<E2EQueryEvaluator.DocEntry> {
        @Suppress("UNCHECKED_CAST")
        val source = (target["source"] as? Map<String, Any?>) ?: target
        val collectionPath = source["path"] as? String
        val collectionGroupId = source["collectionId"] as? String

        val candidateDocs = store.entries.mapNotNull { (path, data) ->
            val id = path.substringAfterLast('/')
            val parentPath = if (path.contains('/')) path.substringBeforeLast('/') else ""

            val matches = if (collectionPath != null) {
                parentPath == collectionPath
            } else if (collectionGroupId != null) {
                parentPath.endsWith(collectionGroupId) || parentPath == collectionGroupId
            } else {
                false
            }

            if (matches) E2EQueryEvaluator.DocEntry(id, path, data) else null
        }

        return E2EQueryEvaluator.evaluate(candidateDocs, target)
    }

    private fun notifySubscribers(touchedPath: String) {
        for (sub in subscriptions) {
            val refType = sub.target["__ref"] as? String
            if (refType == "doc") {
                val subPath = sub.target["path"] as? String
                if (subPath == touchedPath) {
                    emitSnapshot(sub)
                }
            } else {
                // Query subscription
                emitSnapshot(sub)
            }
        }
    }

    private fun emitSnapshot(sub: Subscription) {
        val refType = sub.target["__ref"] as? String
        if (refType == "doc") {
            val path = sub.target["path"] as String
            val idPart = path.substringAfterLast('/')
            val data = store[path]
            val exists = data != null
            val valueMap = if (exists) {
                val encoded = encodeDocData(data!!)
                mapOf(
                    "id" to idPart,
                    "path" to path,
                    "exists" to true,
                    "data" to mapOf("json" to JsonCodec.encodeToString(encoded))
                )
            } else {
                mapOf(
                    "id" to idPart,
                    "path" to path,
                    "exists" to false,
                    "data" to null
                )
            }
            sub.transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf("type" to "worker-snap", "subId" to sub.subId, "value" to valueMap)
                )
            )
        } else {
            val docs = queryDocs(sub.target)
            val docPayloads = docs.map { doc ->
                mapOf(
                    "id" to doc.id,
                    "path" to doc.path,
                    "exists" to true,
                    "data" to mapOf("json" to JsonCodec.encodeToString(encodeDocData(doc.data)))
                )
            }
            sub.transport.sendToClient(
                JsonCodec.encodeToString(
                    mapOf("type" to "worker-snap", "subId" to sub.subId, "value" to mapOf("docs" to docPayloads))
                )
            )
        }
    }

    companion object {
        private val SENTINEL_DELETE = Any()
    }
}
