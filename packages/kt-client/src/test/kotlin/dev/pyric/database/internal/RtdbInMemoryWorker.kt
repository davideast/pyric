package dev.pyric.database.internal

import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class RtdbInMemoryWorker {
    data class NodeData(
        var value: Any? = null,
        var priority: Any? = null
    )

    data class RecordedOp(
        val method: String,
        val path: String,
        val params: Map<String, Any?>,
        val actAs: Map<String, Any?>?
    )

    data class RecordedSub(
        val subId: String,
        val path: String,
        val query: Map<String, Any?>?,
        val actAs: Map<String, Any?>?
    )

    private data class ActiveSub(
        val subId: String,
        val path: String,
        val query: Map<String, Any?>?,
        val actAs: Map<String, Any?>?,
        val transport: InMemoryBridgeTransport
    )

    private data class DisconnectOp(
        val kind: String,
        val path: String,
        val value: Any? = null,
        val priority: Any? = null,
        val values: Map<String, Any?>? = null
    )

    private val tree = ConcurrentHashMap<String, NodeData>()
    private val activeSubs = ConcurrentHashMap<String, ActiveSub>()
    private val disconnectQueue = CopyOnWriteArrayList<DisconnectOp>()

    val recordedOps = CopyOnWriteArrayList<RecordedOp>()
    val recordedSubs = CopyOnWriteArrayList<RecordedSub>()

    @Volatile
    var isOffline: Boolean = false
        private set

    fun createBridgeClient(): PyricBridgeClient {
        val transport = InMemoryBridgeTransport()
        val client = PyricBridgeClient(transport)
        transport.onServerReceive { jsonStr ->
            handleMessage(jsonStr, transport)
        }
        return client
    }

    private fun handleMessage(jsonStr: String, transport: InMemoryBridgeTransport) {
        val msg = try {
            JsonCodec.decodeMap(jsonStr)
        } catch (_: Exception) {
            return
        }

        when (msg["type"] as? String) {
            "attach" -> {
                transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            }
            "worker-op" -> {
                val id = msg["id"] as? String ?: return
                @Suppress("UNCHECKED_CAST")
                val op = msg["op"] as? Map<String, Any?> ?: return
                val method = op["method"] as? String ?: return
                val path = (op["path"] as? String)?.trim('/') ?: ""
                @Suppress("UNCHECKED_CAST")
                val actAs = op["actAs"] as? Map<String, Any?>

                recordedOps.add(RecordedOp(method, path, op, actAs))

                try {
                    val result = executeOp(method, path, op)
                    val resFrame = mapOf(
                        "type" to "worker-res",
                        "id" to id,
                        "ok" to true,
                        "value" to result
                    )
                    transport.sendToClient(JsonCodec.encodeToString(resFrame))
                } catch (e: Throwable) {
                    val errFrame = mapOf(
                        "type" to "worker-res",
                        "id" to id,
                        "ok" to false,
                        "error" to mapOf("code" to "unknown", "message" to (e.message ?: "Error"))
                    )
                    transport.sendToClient(JsonCodec.encodeToString(errFrame))
                }
            }
            "worker-sub" -> {
                val subId = msg["subId"] as? String ?: return
                @Suppress("UNCHECKED_CAST")
                val subPayload = (msg["sub"] ?: msg["payload"]) as? Map<String, Any?> ?: return
                @Suppress("UNCHECKED_CAST")
                val target = subPayload["target"] as? Map<String, Any?> ?: return
                val path = (target["path"] as? String)?.trim('/') ?: ""
                @Suppress("UNCHECKED_CAST")
                val query = target["query"] as? Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                val actAs = subPayload["actAs"] as? Map<String, Any?>

                recordedSubs.add(RecordedSub(subId, path, query, actAs))
                val sub = ActiveSub(subId, path, query, actAs, transport)
                activeSubs[subId] = sub
                emitSnapshot(sub)
            }
            "worker-unsub" -> {
                val subId = msg["subId"] as? String ?: return
                activeSubs.remove(subId)
            }
        }
    }

    private fun executeOp(method: String, path: String, op: Map<String, Any?>): Any? {
        return when (method) {
            "rtdb.get" -> {
                @Suppress("UNCHECKED_CAST")
                val query = op["query"] as? Map<String, Any?>
                buildWireSnapshot(path, query)
            }
            "rtdb.set" -> {
                val resolved = resolveSentinels(path, op["value"])
                setNodeValue(path, resolved, preservePriority = false, newPriority = null)
                notifySubscribers()
                null
            }
            "rtdb.setPriority" -> {
                val prio = op["priority"]
                val existing = getNodeValue(path)
                setNodeValue(path, existing, preservePriority = false, newPriority = prio)
                notifySubscribers()
                null
            }
            "rtdb.setWithPriority" -> {
                val resolved = resolveSentinels(path, op["value"])
                val prio = op["priority"]
                setNodeValue(path, resolved, preservePriority = false, newPriority = prio)
                notifySubscribers()
                null
            }
            "rtdb.update" -> {
                @Suppress("UNCHECKED_CAST")
                val values = op["values"] as? Map<String, Any?> ?: emptyMap()
                for ((k, v) in values) {
                    val childPath = if (path.isEmpty()) k.trim('/') else "$path/${k.trim('/')}"
                    val resolved = resolveSentinels(childPath, v)
                    setNodeValue(childPath, resolved, preservePriority = true, newPriority = null)
                }
                notifySubscribers()
                null
            }
            "rtdb.remove" -> {
                setNodeValue(path, null, preservePriority = false, newPriority = null)
                notifySubscribers()
                null
            }
            "rtdb.push" -> {
                val key = op["key"] as? String ?: PushIdGenerator.generatePushId()
                val childPath = if (path.isEmpty()) key else "$path/$key"
                if (op.containsKey("value") && op["value"] != null) {
                    val resolved = resolveSentinels(childPath, op["value"])
                    setNodeValue(childPath, resolved, preservePriority = false, newPriority = null)
                    notifySubscribers()
                }
                mapOf("key" to key, "path" to "/$childPath")
            }
            "rtdb.transactionCommit" -> {
                val expected = op["expected"]
                val current = getNodeValue(path)
                if (current != expected) {
                    mapOf(
                        "retry" to true,
                        "committed" to false,
                        "snapshot" to buildWireSnapshot(path, null)
                    )
                } else {
                    val resolved = resolveSentinels(path, op["value"])
                    setNodeValue(path, resolved, preservePriority = true, newPriority = null)
                    notifySubscribers()
                    mapOf(
                        "retry" to false,
                        "committed" to true,
                        "snapshot" to buildWireSnapshot(path, null)
                    )
                }
            }
            "rtdb.onDisconnectSet" -> {
                disconnectQueue.add(
                    DisconnectOp("set", path, value = op["value"], priority = op["priority"])
                )
                null
            }
            "rtdb.onDisconnectUpdate" -> {
                @Suppress("UNCHECKED_CAST")
                val values = op["values"] as? Map<String, Any?>
                disconnectQueue.add(DisconnectOp("update", path, values = values))
                null
            }
            "rtdb.onDisconnectRemove" -> {
                disconnectQueue.add(DisconnectOp("remove", path))
                null
            }
            "rtdb.onDisconnectCancel" -> {
                disconnectQueue.removeIf { it.path == path }
                null
            }
            "rtdb.goOffline" -> {
                isOffline = true
                val toRun = ArrayList(disconnectQueue)
                disconnectQueue.clear()
                for (dop in toRun) {
                    when (dop.kind) {
                        "set" -> {
                            val resolved = resolveSentinels(dop.path, dop.value)
                            setNodeValue(dop.path, resolved, false, dop.priority)
                        }
                        "update" -> {
                            dop.values?.forEach { (k, v) ->
                                val cp = if (dop.path.isEmpty()) k.trim('/') else "${dop.path}/${k.trim('/')}"
                                setNodeValue(cp, resolveSentinels(cp, v), true, null)
                            }
                        }
                        "remove" -> setNodeValue(dop.path, null, false, null)
                    }
                }
                notifySubscribers()
                null
            }
            "rtdb.goOnline" -> {
                isOffline = false
                null
            }
            else -> null
        }
    }

    private fun resolveSentinels(path: String, value: Any?): Any? {
        if (value is Map<*, *>) {
            val sv = value[".sv"]
            val rtdbSentinel = value["__rtdbSentinel"]
            if (sv == "timestamp" || rtdbSentinel == "serverTimestamp") {
                return System.currentTimeMillis()
            }
            if (sv is Map<*, *> && sv.containsKey("increment")) {
                val delta = (sv["increment"] as? Number)?.toDouble() ?: 0.0
                val currentVal = (getNodeValue(path) as? Number)?.toDouble() ?: 0.0
                val sum = currentVal + delta
                return if (sum % 1.0 == 0.0) sum.toLong() else sum
            }
            return value.entries.associate { (k, v) ->
                val childPath = if (path.isEmpty()) k.toString() else "$path/$k"
                k.toString() to resolveSentinels(childPath, v)
            }
        }
        if (value is List<*>) {
            return value.mapIndexed { idx, item ->
                resolveSentinels("$path/$idx", item)
            }
        }
        return value
    }

    private fun setNodeValue(
        path: String,
        value: Any?,
        preservePriority: Boolean,
        newPriority: Any?
    ) {
        val clean = path.trim('/')
        val prefix = if (clean.isEmpty()) "" else "$clean/"
        val keysToRemove = tree.keys.filter { it == clean || (prefix.isNotEmpty() && it.startsWith(prefix)) }
        val oldPrio = tree[clean]?.priority
        for (k in keysToRemove) {
            tree.remove(k)
        }

        if (value == null) return

        val prioToSet = if (preservePriority) oldPrio else newPriority
        writeSubtree(clean, value, prioToSet)
    }

    private fun writeSubtree(path: String, value: Any?, priority: Any?) {
        if (value is Map<*, *>) {
            if (priority != null) {
                tree[path] = NodeData(value = null, priority = priority)
            }
            for ((k, v) in value) {
                if (v != null) {
                    val childPath = if (path.isEmpty()) k.toString() else "$path/$k"
                    writeSubtree(childPath, v, null)
                }
            }
        } else {
            tree[path] = NodeData(value = value, priority = priority)
        }
    }

    private fun getNodeValue(path: String): Any? {
        val clean = path.trim('/')
        val exact = tree[clean]
        if (exact?.value != null) return exact.value

        val prefix = if (clean.isEmpty()) "" else "$clean/"
        val childEntries = tree.entries.filter {
            if (prefix.isEmpty()) it.key.isNotEmpty()
            else it.key.startsWith(prefix)
        }
        if (childEntries.isEmpty()) return null

        val result = mutableMapOf<String, Any?>()
        for ((fullPath, nodeData) in childEntries) {
            if (nodeData.value == null) continue
            val rel = if (prefix.isEmpty()) fullPath else fullPath.removePrefix(prefix)
            val segments = rel.split('/')
            var curr = result
            for (i in 0 until segments.size - 1) {
                val seg = segments[i]
                @Suppress("UNCHECKED_CAST")
                val next = curr.getOrPut(seg) { mutableMapOf<String, Any?>() } as MutableMap<String, Any?>
                curr = next
            }
            curr[segments.last()] = nodeData.value
        }
        return result
    }

    private fun getNodePriority(path: String): Any? = tree[path.trim('/')]?.priority

    private fun buildWireSnapshot(path: String, query: Map<String, Any?>?): Map<String, Any?> {
        val clean = path.trim('/')
        val key = if (clean.isEmpty()) null else clean.substringAfterLast('/')
        val rawVal = getNodeValue(clean)
        val priority = getNodePriority(clean)

        if (rawVal == null) {
            return mapOf(
                "key" to key,
                "exists" to false,
                "value" to null,
                "size" to 0,
                "priority" to priority,
                "entries" to emptyList<Map<String, Any?>>()
            )
        }

        if (rawVal !is Map<*, *>) {
            return mapOf(
                "key" to key,
                "exists" to true,
                "value" to rawVal,
                "size" to 0,
                "priority" to priority,
                "entries" to emptyList<Map<String, Any?>>()
            )
        }

        data class ChildItem(val key: String, val value: Any?, val priority: Any?)
        val children = rawVal.entries.map { (k, v) ->
            val childPath = if (clean.isEmpty()) k.toString() else "$clean/$k"
            ChildItem(k.toString(), v, getNodePriority(childPath))
        }

        @Suppress("UNCHECKED_CAST")
        val orderBy = query?.get("orderBy") as? Map<String, Any?>
        val orderKind = orderBy?.get("kind") as? String
        val orderPath = orderBy?.get("path") as? String

        fun extractComparisonValue(item: ChildItem): Any? {
            return when (orderKind) {
                "key" -> item.key
                "value" -> item.value
                "priority" -> item.priority
                "child" -> {
                    if (item.value is Map<*, *> && orderPath != null) {
                        item.value[orderPath]
                    } else null
                }
                else -> item.key
            }
        }

        val sorted = children.sortedWith { a, b ->
            val cmp = compareRtdbValues(extractComparisonValue(a), extractComparisonValue(b))
            if (cmp != 0) cmp else a.key.compareTo(b.key)
        }

        @Suppress("UNCHECKED_CAST")
        val bounds = query?.get("bounds") as? List<Map<String, Any?>> ?: emptyList()
        val filtered = sorted.filter { item ->
            val compVal = extractComparisonValue(item)
            bounds.all { bound ->
                val kind = bound["kind"] as? String
                val boundVal = bound["value"]
                val cmp = compareRtdbValues(compVal, boundVal)
                when (kind) {
                    "equalTo" -> cmp == 0
                    "startAt" -> cmp >= 0
                    "startAfter" -> cmp > 0
                    "endAt" -> cmp <= 0
                    "endBefore" -> cmp < 0
                    else -> true
                }
            }
        }

        @Suppress("UNCHECKED_CAST")
        val limit = query?.get("limit") as? Map<String, Any?>
        val limitKind = limit?.get("kind") as? String
        val limitN = (limit?.get("n") as? Number)?.toInt()

        val limited = if (limitN != null) {
            when (limitKind) {
                "limitToFirst" -> filtered.take(limitN)
                "limitToLast" -> filtered.takeLast(limitN)
                else -> filtered
            }
        } else filtered

        val entriesList = limited.map { item ->
            mapOf("key" to item.key, "value" to item.value, "priority" to item.priority)
        }
        val valueMap = limited.associate { it.key to it.value }

        return mapOf(
            "key" to key,
            "exists" to valueMap.isNotEmpty(),
            "value" to if (valueMap.isEmpty()) null else valueMap,
            "size" to entriesList.size,
            "priority" to priority,
            "entries" to entriesList
        )
    }

    private fun compareRtdbValues(a: Any?, b: Any?): Int {
        if (a === b) return 0
        if (a == null) return -1
        if (b == null) return 1
        if (a is Boolean && b is Boolean) return a.compareTo(b)
        if (a is Boolean) return -1
        if (b is Boolean) return 1
        if (a is Number && b is Number) return a.toDouble().compareTo(b.toDouble())
        if (a is Number) return -1
        if (b is Number) return 1
        return a.toString().compareTo(b.toString())
    }

    private fun notifySubscribers() {
        for (sub in activeSubs.values) {
            emitSnapshot(sub)
        }
    }

    private fun emitSnapshot(sub: ActiveSub) {
        val snap = buildWireSnapshot(sub.path, sub.query)
        val frame = mapOf(
            "type" to "worker-snap",
            "subId" to sub.subId,
            "value" to snap
        )
        sub.transport.sendToClient(JsonCodec.encodeToString(frame))
    }
}
