package dev.pyric.bridge

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.QuerySnapshot
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/**
 * One fake socket. [drop] ends it the way a lost connection does. It delivers
 * nothing it is not told to, so a socket left alone stays open and silent, the
 * way a half-open connection does.
 */
class FakeReconnectSocket(
    private val bridge: FakeReconnectBridge,
    private val listener: BridgeListener
) : BridgeTransport {
    @Volatile var open = true
        private set

    /** Every frame the client tried to send here, including after the socket closed. */
    val attempted = CopyOnWriteArrayList<Map<String, Any?>>()

    fun pings(): Int = attempted.count { it["type"] == "ping" }

    override fun send(text: String): Boolean {
        attempted.add(JsonCodec.decodeMap(text))
        if (!open) return false
        bridge.record(JsonCodec.decodeMap(text), this)
        return true
    }

    override fun close(code: Int, reason: String?): Boolean {
        open = false
        return true
    }

    override fun setListener(listener: BridgeListener) {}

    fun deliver(frame: Map<String, Any?>) {
        if (open) listener.onMessage(JsonCodec.encodeToString(frame))
    }

    fun drop(code: Int = 1006) {
        if (!open) return
        open = false
        listener.onClosed(code, "dropped")
    }
}

/** Hands out a new socket per connection and records every frame across all of them. */
class FakeReconnectBridge : BridgeTransportFactory {
    val frames = CopyOnWriteArrayList<Map<String, Any?>>()
    val sockets = CopyOnWriteArrayList<FakeReconnectSocket>()
    @Volatile var hostInstanceId = "host-a"
    @Volatile var refuseConnections = false
    @Volatile var autoAck = true
    /** Off by default: the bridge leaves pings unanswered, so a socket goes silent. */
    @Volatile var answerPings = false
    val connectCalls = java.util.concurrent.atomic.AtomicInteger(0)
    private val io = Executors.newSingleThreadExecutor()

    val current: FakeReconnectSocket get() = sockets.last()

    override fun create(url: String, headers: Map<String, String>, listener: BridgeListener): BridgeTransport {
        connectCalls.incrementAndGet()
        if (refuseConnections) throw IllegalStateException("connection refused")
        val socket = FakeReconnectSocket(this, listener)
        sockets.add(socket)
        // Opens on the transport's own thread, as OkHttp does.
        io.execute { listener.onOpen() }
        return socket
    }

    /** Runs on the sending thread after each frame is recorded. */
    @Volatile var onFrame: ((Map<String, Any?>) -> Unit)? = null

    fun record(frame: Map<String, Any?>, socket: FakeReconnectSocket) {
        frames.add(frame)
        onFrame?.invoke(frame)
        if (frame["type"] == "ping" && answerPings) {
            val id = frame["id"]
            io.execute { socket.deliver(mapOf("type" to "pong", "id" to id)) }
        }
        if (frame["type"] == "attach" && autoAck) {
            val sessionId = frame["clientSessionId"] as? String ?: "session-1"
            val host = hostInstanceId
            io.execute {
                socket.deliver(
                    mapOf(
                        "type" to "attach-ack",
                        "protocol" to 1,
                        "peerConnected" to true,
                        "clientSessionId" to sessionId,
                        "hostInstanceId" to host
                    )
                )
            }
        }
    }

    fun ofType(type: String): List<Map<String, Any?>> = frames.filter { it["type"] == type }

    @Suppress("UNCHECKED_CAST")
    private fun targetPath(frame: Map<String, Any?>): Any? {
        val target = (frame["sub"] as? Map<String, Any?>)?.get("target")
        val targetMap = target as? Map<String, Any?> ?: return target
        return targetMap["path"] ?: (targetMap["source"] as? Map<String, Any?>)?.get("path")
    }

    fun subsFor(pathOrTarget: String): List<Map<String, Any?>> =
        ofType("worker-sub").filter { targetPath(it) == pathOrTarget }

    @Suppress("UNCHECKED_CAST")
    fun opsNamed(method: String): List<Map<String, Any?>> =
        ofType("worker-op").filter { (it["op"] as? Map<String, Any?>)?.get("method") == method }

    fun shutdown() {
        io.shutdownNow()
    }
}

class BridgeReconnectTest {
    private val bridge = FakeReconnectBridge()
    private val clients = mutableListOf<PyricBridgeClient>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun client(
        retryInitialConnection: Boolean = false,
        retryDelayMs: Long = 5L,
        attachTimeoutMs: Long = 5_000L,
        holdTimeoutMs: Long? = null,
        heartbeatIntervalMs: Long? = null,
        livenessTimeoutMs: Long? = null
    ): PyricBridgeClient =
        PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            retryInitialConnection = retryInitialConnection,
            reconnectDelayMs = { retryDelayMs },
            attachTimeoutMs = attachTimeoutMs
        ).also { created ->
            if (holdTimeoutMs != null) created.holdTimeoutMs = holdTimeoutMs
            if (heartbeatIntervalMs != null) created.heartbeatIntervalMs = heartbeatIntervalMs
            if (livenessTimeoutMs != null) created.livenessTimeoutMs = livenessTimeoutMs
            clients.add(created)
        }

    private fun respond(frame: Map<String, Any?>, value: Any?) {
        bridge.current.deliver(mapOf("type" to "worker-res", "id" to frame["id"], "ok" to true, "value" to value))
    }

    // By identity: a re-sent subscription frame equals the original one.
    private fun indexOfFrame(frame: Map<String, Any?>): Int =
        bridge.frames.indexOfFirst { it === frame }

    private suspend fun interrupt(client: PyricBridgeClient) {
        client.connect()
        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
    }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) delay(5)
        }
    }

    @AfterEach
    fun tearDown() {
        runBlocking { clients.forEach { it.disconnect() } }
        scope.cancel()
        bridge.shutdown()
    }

    @Test
    fun `a pending operation fails once with unavailable on a drop and is never re-sent`() = runBlocking {
        val client = client()
        client.connect()
        val pending = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        until { bridge.opsNamed("setDoc").size == 1 }
        val sentId = bridge.opsNamed("setDoc").single()["id"]

        bridge.current.drop()
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { pending.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(error.message!!.contains("connection was lost"))

        until { client.isConnected }
        assertEquals(1, bridge.ofType("worker-op").count { it["id"] == sentId })
    }

    @Test
    fun `re-attaches with the session id from the first attach-ack and re-sends live listens`() = runBlocking {
        val client = client()
        val values = CopyOnWriteArrayList<Any?>()
        val errors = CopyOnWriteArrayList<Throwable>()
        scope.launch {
            try {
                client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect { values.add(it) }
            } catch (e: Throwable) {
                errors.add(e)
            }
        }
        until { bridge.subsFor("rooms/a").size == 1 }
        val subId = bridge.subsFor("rooms/a").single()["subId"]
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("path" to "rooms/a", "exists" to true, "data" to mapOf("n" to 1))))
        until { values.size == 1 }

        bridge.current.drop()
        until { bridge.subsFor("rooms/a").size == 2 }
        assertEquals("session-1", bridge.ofType("attach").last()["clientSessionId"])
        assertEquals(subId, bridge.subsFor("rooms/a").last()["subId"])

        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("path" to "rooms/a", "exists" to true, "data" to mapOf("n" to 2))))
        until { values.size == 2 }
        assertTrue(errors.isEmpty())
    }

    @Test
    fun `a restored value equal to the last one is not raised to a listener without metadata changes`() = runBlocking {
        val client = client()
        val values = CopyOnWriteArrayList<Any?>()
        scope.launch { try { client.subscribe("authState").collect { values.add(it) } } catch (_: Throwable) {} }
        until { bridge.subsFor("authState").size == 1 }
        val subId = bridge.subsFor("authState").single()["subId"]
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("uid" to "u1")))
        until { values.size == 1 }

        bridge.current.drop()
        until { bridge.subsFor("authState").size == 2 }
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("uid" to "u1")))
        delay(30)
        assertEquals(1, values.size)

        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("uid" to "u2")))
        until { values.size == 2 }
    }

    @Test
    fun `a subscription with metadata changes receives a gap on the drop, then the restored value`() = runBlocking {
        val client = client()
        val values = CopyOnWriteArrayList<Any?>()
        scope.launch {
            try {
                client.subscribe(mapOf("__ref" to "collection", "path" to "rooms"), includeMetadataChanges = true)
                    .collect { values.add(it) }
            } catch (_: Throwable) {}
        }
        until { bridge.subsFor("rooms").size == 1 }
        val subId = bridge.subsFor("rooms").single()["subId"]
        val docs = mapOf("docs" to listOf(mapOf("id" to "a", "path" to "rooms/a", "exists" to true, "data" to mapOf("n" to 1))))
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to docs))
        until { values.size == 1 }

        bridge.current.drop()
        until { values.size == 2 }
        assertTrue(values[1] === BridgeSubscriptionGap)

        until { bridge.subsFor("rooms").size == 2 }
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to docs))
        until { values.size == 3 }
        assertFalse(values[2] === BridgeSubscriptionGap)
    }

    @Test
    fun `operations issued while interrupted reach the host exactly once after re-attach, in issue order`() = runBlocking {
        val client = client()
        interrupt(client)

        val first = scope.async { client.op("getDoc", mapOf("path" to "rooms/a")) }
        delay(20)
        val second = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)
        assertTrue(bridge.ofType("worker-op").isEmpty())
        assertFalse(first.isCompleted, "a held operation neither fails nor is sent")
        assertFalse(second.isCompleted, "a held operation neither fails nor is sent")

        bridge.refuseConnections = false
        until { bridge.ofType("worker-op").size == 2 }
        val sent = bridge.ofType("worker-op")
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("getDoc", "setDoc"), sent.map { (it["op"] as Map<String, Any?>)["method"] })
        respond(sent[0], "a")
        respond(sent[1], "b")
        assertEquals("a", first.await())
        assertEquals("b", second.await())
        delay(30)
        assertEquals(2, bridge.ofType("worker-op").size)
    }

    @Test
    fun `an operation issued after re-attach while held operations are being sent reaches the socket after them`() = runBlocking {
        val client = client()
        interrupt(client)
        val a = scope.async { client.op("getDoc", mapOf("path" to "rooms/a")) }
        delay(20)
        val b = scope.async { client.op("getDoc", mapOf("path" to "rooms/b")) }
        delay(30)

        // Issues C from inside the send of A, while B is still held, and gives a
        // C that skipped the queue time to reach the socket first.
        val c = java.util.concurrent.atomic.AtomicReference<kotlinx.coroutines.Deferred<Any?>>()
        val attachedAtIssue = java.util.concurrent.atomic.AtomicBoolean(false)
        bridge.onFrame = { frame ->
            @Suppress("UNCHECKED_CAST")
            val path = (frame["op"] as? Map<String, Any?>)?.get("path")
            if (frame["type"] == "worker-op" && path == "rooms/a" && c.get() == null) {
                attachedAtIssue.set(client.isConnected)
                c.set(scope.async { client.op("getDoc", mapOf("path" to "rooms/c")) })
                Thread.sleep(100)
            }
        }
        bridge.refuseConnections = false
        until { bridge.ofType("worker-op").size == 3 }
        assertTrue(attachedAtIssue.get(), "C is issued after re-attach")

        val sent = bridge.ofType("worker-op")
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("rooms/a", "rooms/b", "rooms/c"), sent.map { (it["op"] as Map<String, Any?>)["path"] })
        sent.forEach { respond(it, it["id"]) }
        assertEquals(sent[0]["id"], a.await())
        assertEquals(sent[1]["id"], b.await())
        assertEquals(sent[2]["id"], c.get().await())
    }

    @Test
    fun `an operation issued while restoring on a replaced host is sent after the Auth restore and the listener replay`() = runBlocking {
        val client = client()
        client.restoreAuth = { op -> op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null)) }
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect {} } catch (_: Throwable) {} }
        until { bridge.subsFor("rooms/a").size == 1 }

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        until { bridge.opsNamed("auth.restorePortSession").size == 1 }
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)
        assertTrue(bridge.opsNamed("setDoc").isEmpty())
        assertFalse(held.isCompleted)

        respond(bridge.opsNamed("auth.restorePortSession").single(), mapOf("uid" to "u1"))
        until { bridge.opsNamed("setDoc").size == 1 }
        val restoreAt = indexOfFrame(bridge.opsNamed("auth.restorePortSession").single())
        val replayAt = indexOfFrame(bridge.subsFor("rooms/a").last())
        val heldAt = indexOfFrame(bridge.opsNamed("setDoc").single())
        assertEquals(2, bridge.subsFor("rooms/a").size)
        assertTrue(restoreAt < replayAt, "the listener replay follows the Auth restore")
        assertTrue(replayAt < heldAt, "the held operation follows the listener replay")

        respond(bridge.opsNamed("setDoc").single(), null)
        held.await()
        Unit
    }

    @Test
    fun `an operation held past the deadline fails once, saying it was not sent, and a later attach never sends it`() = runBlocking {
        val client = client(holdTimeoutMs = 100L)
        interrupt(client)

        val issuedAt = System.nanoTime()
        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("setDoc", mapOf("path" to "rooms/a")) }
        }
        val heldMs = (System.nanoTime() - issuedAt) / 1_000_000
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("The bridge connection was not restored within 10 seconds. The request was not sent.", error.message)
        assertTrue(heldMs >= 90, "the operation was held for ${heldMs}ms, not until the deadline")

        bridge.refuseConnections = false
        until { client.isConnected }
        delay(50)
        assertTrue(bridge.opsNamed("setDoc").isEmpty())
    }

    @Test
    fun `a failed Auth restore fails held operations without sending them`() = runBlocking {
        val client = client()
        client.restoreAuth = { op -> op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null)) }
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect {} } catch (_: Throwable) {} }
        until { bridge.subsFor("rooms/a").size == 1 }

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        until { bridge.opsNamed("auth.restorePortSession").size == 1 }
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)

        val restore = bridge.opsNamed("auth.restorePortSession").single()
        bridge.current.deliver(
            mapOf(
                "type" to "worker-res",
                "id" to restore["id"],
                "ok" to false,
                "error" to mapOf("code" to "internal", "message" to "restore failed")
            )
        )
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { held.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals(
            "The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent.",
            error.message
        )

        until { client.isConnected }
        until { bridge.subsFor("rooms/a").size == 2 }
        delay(50)
        assertTrue(bridge.opsNamed("setDoc").isEmpty())
    }

    /** Attaches to host-a, then re-attaches to a replaced host-b whose Auth restore is in flight. */
    private suspend fun replaceHostAndAwaitRestore(client: PyricBridgeClient) {
        client.restoreAuth = { op -> op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null)) }
        client.connect()
        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        until { bridge.opsNamed("auth.restorePortSession").size == 1 }
    }

    @Test
    fun `a drop during the Auth restore on a replaced host restores Auth on the next attach to that host`() = runBlocking {
        val client = client()
        replaceHostAndAwaitRestore(client)
        bridge.current.drop()

        until { bridge.opsNamed("auth.restorePortSession").size == 2 }
        val retried = bridge.opsNamed("auth.restorePortSession").last()
        @Suppress("UNCHECKED_CAST")
        assertEquals("u1", (retried["op"] as Map<String, Any?>)["uid"])
        respond(retried, mapOf("uid" to "u1"))
        until { client.isConnected }
    }

    @Test
    fun `an operation held across a drop during the Auth restore is sent once, after the restore completes`() = runBlocking {
        val client = client()
        replaceHostAndAwaitRestore(client)
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)
        bridge.current.drop()

        until { bridge.opsNamed("auth.restorePortSession").size == 2 }
        delay(30)
        assertTrue(bridge.opsNamed("setDoc").isEmpty(), "the held operation waits for the restore")
        assertFalse(held.isCompleted)

        val restore = bridge.opsNamed("auth.restorePortSession").last()
        respond(restore, mapOf("uid" to "u1"))
        until { bridge.opsNamed("setDoc").size == 1 }
        val sent = bridge.opsNamed("setDoc").single()
        assertTrue(indexOfFrame(restore) < indexOfFrame(sent), "the held operation follows the completed restore")
        respond(sent, null)
        held.await()
        delay(30)
        assertEquals(1, bridge.opsNamed("setDoc").size)
    }

    @Test
    fun `a resume to the same host after a completed restore does not restore Auth again`() = runBlocking {
        val client = client()
        replaceHostAndAwaitRestore(client)
        respond(bridge.opsNamed("auth.restorePortSession").single(), mapOf("uid" to "u1"))
        until { client.isConnected }

        bridge.current.drop()
        until { bridge.ofType("attach").size == 3 }
        until { client.isConnected }
        delay(50)
        assertEquals(1, bridge.opsNamed("auth.restorePortSession").size)
    }

    @Test
    fun `disconnect while holding fails held operations once and sends none`() = runBlocking {
        val client = client()
        interrupt(client)
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        delay(30)
        assertFalse(held.isCompleted)

        client.disconnect()
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { held.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("PyricBridgeClient disconnected.", error.message)

        bridge.refuseConnections = false
        delay(50)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `a policy close while reconnecting fails held operations once and sends none`() = runBlocking {
        val client = client()
        client.connect()
        bridge.autoAck = false
        bridge.current.drop()
        until { bridge.ofType("attach").size == 2 }
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        delay(30)
        assertFalse(held.isCompleted)

        bridge.current.drop(code = 1008)
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { held.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(error.message!!.contains("(1008)"), error.message)
        assertEquals(BridgeConnectionState.CLOSED, client.connectionState)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `an operation issued before the first attach is held across failed attempts and sent once by the next`() = runBlocking {
        bridge.refuseConnections = true
        val client = client(retryInitialConnection = true, retryDelayMs = 20L)
        val values = CopyOnWriteArrayList<Any?>()
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect { values.add(it) } } catch (_: Throwable) {} }

        val callsAtIssue = bridge.connectCalls.get()
        val queued = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        until { bridge.connectCalls.get() >= callsAtIssue + 2 }
        assertFalse(queued.isCompleted, "a failed attempt that permits a retry does not fail a held operation")
        assertFalse(client.isDisposed)

        bridge.refuseConnections = false
        until { bridge.opsNamed("setDoc").size == 1 }
        respond(bridge.opsNamed("setDoc").single(), null)
        queued.await()
        until { bridge.subsFor("rooms/a").size == 1 }
        val subId = bridge.subsFor("rooms/a").single()["subId"]
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("path" to "rooms/a", "exists" to false)))
        until { values.size == 1 }
        assertEquals(1, bridge.opsNamed("setDoc").size)
    }

    @Test
    fun `an operation issued before the first attach and held past the deadline is never sent`() = runBlocking {
        bridge.refuseConnections = true
        val client = client(retryInitialConnection = true, retryDelayMs = 20L, holdTimeoutMs = 100L)
        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("setDoc", mapOf("path" to "rooms/a")) }
        }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("The bridge connection was not restored within 10 seconds. The request was not sent.", error.message)

        bridge.refuseConnections = false
        until { client.isConnected }
        delay(50)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `without retryInitialConnection an operation issued before the first attach fails when the attempt fails`() = runBlocking {
        bridge.refuseConnections = true
        val client = client()
        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("setDoc", mapOf("path" to "rooms/a")) }
        }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals(BridgeConnectionState.CLOSED, client.connectionState)
        bridge.refuseConnections = false
        delay(50)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `without retryInitialConnection the first failed attempt fails connect and schedules nothing`() = runBlocking {
        bridge.refuseConnections = true
        val client = client()
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { client.connect() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals(BridgeConnectionState.CLOSED, client.connectionState)
        bridge.refuseConnections = false
        delay(50)
        assertTrue(bridge.sockets.isEmpty())
    }

    @Test
    fun `a policy close (1008) closes the client instead of reconnecting`() = runBlocking {
        val client = client()
        client.connect()
        bridge.current.drop(code = 1008)
        until { client.connectionState == BridgeConnectionState.CLOSED }
        delay(50)
        assertEquals(1, bridge.ofType("attach").size)
    }

    @Test
    fun `a replaced host runs the Auth restore before any listen is re-sent`() = runBlocking {
        val client = client()
        val restores = CopyOnWriteArrayList<String>()
        client.restoreAuth = { op ->
            restores.add("called")
            op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null))
        }
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect {} } catch (_: Throwable) {} }
        until { bridge.subsFor("rooms/a").size == 1 }

        bridge.current.drop()
        until { bridge.subsFor("rooms/a").size == 2 }
        assertTrue(restores.isEmpty())

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        until { bridge.opsNamed("auth.restorePortSession").size == 1 }
        val restore = bridge.opsNamed("auth.restorePortSession").single()
        @Suppress("UNCHECKED_CAST")
        assertEquals("u1", (restore["op"] as Map<String, Any?>)["uid"])
        assertEquals(2, bridge.subsFor("rooms/a").size)

        bridge.current.deliver(mapOf("type" to "worker-res", "id" to restore["id"], "ok" to true, "value" to mapOf("uid" to "u1")))
        until { bridge.subsFor("rooms/a").size == 3 }
    }

    @Test
    fun `reconnect delays follow the bounded jittered schedule`() {
        val bases = listOf(250L, 500L, 1000L, 2000L, 4000L, 5000L, 5000L, 5000L)
        bases.forEachIndexed { attempt, base ->
            for (random in listOf(0.0, 0.5, 0.999)) {
                val delayMs = bridgeReconnectDelayMs(attempt, random)
                assertTrue(delayMs >= base, "attempt $attempt: $delayMs < $base")
                assertTrue(delayMs <= minOf(5000L, base + minOf(250L, base / 10)), "attempt $attempt: $delayMs too long")
            }
        }
        assertTrue(bridgeReconnectDelayMs(60, 0.999) <= 5000L)
    }

    @Test
    fun `a query listener with metadata changes reports the gap with isFromCache`() = runBlocking {
        val client = client()
        val app = FirebaseApp.initializeApp(
            "reconnect-${System.nanoTime()}",
            FirebaseOptions.Builder().setProjectId("demo-test").setApiKey("fake-key").setApplicationId("fake-app").build()
        )
        val firestore = FirebaseFirestore(client, app, "(default)")
        val snapshots = CopyOnWriteArrayList<QuerySnapshot>()
        scope.launch {
            try {
                firestore.collection("rooms").snapshots(MetadataChanges.INCLUDE).collect { snapshots.add(it) }
            } catch (_: Throwable) {}
        }
        until { bridge.subsFor("rooms").size == 1 }
        val subId = bridge.subsFor("rooms").single()["subId"]
        val docA = mapOf("id" to "a", "path" to "rooms/a", "exists" to true, "data" to mapOf("n" to 1))
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("docs" to listOf(docA))))
        until { snapshots.size == 1 }
        assertFalse(snapshots[0].metadata.isFromCache)

        bridge.current.drop()
        until { snapshots.size == 2 }
        assertTrue(snapshots[1].metadata.isFromCache)
        assertFalse(snapshots[1].metadata.hasPendingWrites)
        assertEquals(listOf("a"), snapshots[1].documents.map { it.id })

        until { bridge.subsFor("rooms").size == 2 }
        val docB = mapOf("id" to "b", "path" to "rooms/b", "exists" to true, "data" to mapOf("n" to 1))
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("docs" to listOf(docA, docB))))
        until { snapshots.size == 3 }
        assertFalse(snapshots[2].metadata.isFromCache)
        assertEquals(listOf("a", "b"), snapshots[2].documents.map { it.id })
    }

    @Test
    fun `before the first attach an operation waits for the next scheduled attempt instead of starting one`() = runBlocking {
        bridge.refuseConnections = true
        val client = client(retryInitialConnection = true, retryDelayMs = 300L)
        assertThrows<FirebaseFirestoreException> { runBlocking { client.connect() } }
        val callsBefore = bridge.connectCalls.get()

        val queued = scope.async { client.op("getDoc", mapOf("path" to "rooms/a")) }
        delay(50)
        assertEquals(callsBefore, bridge.connectCalls.get(), "the operation must not start an attempt early")

        bridge.refuseConnections = false
        until { bridge.opsNamed("getDoc").isNotEmpty() }
        assertEquals(callsBefore + 1, bridge.connectCalls.get())
        val sent = bridge.opsNamed("getDoc").single()
        bridge.current.deliver(mapOf("type" to "worker-res", "id" to sent["id"], "ok" to true, "value" to null))
        queued.await()
        Unit
    }

    @Test
    fun `an attempt that is not acknowledged within the attach timeout fails`() = runBlocking {
        bridge.autoAck = false
        val client = client(attachTimeoutMs = 50L)
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { client.connect() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(error.message!!.contains("Timed out"))
    }

    @Test
    fun `a late close from an earlier attempt does not end a manual reconnect on a supplied transport`() = runBlocking {
        val transport = RecordingTransport()
        val client = PyricBridgeClient(transport).also { clients.add(it) }
        until { transport.attachCount() == 1 }
        transport.ack()
        client.connect()
        val firstListener = transport.listeners.last()

        firstListener.onClosed(1006, "dropped")
        until { client.connectionState == BridgeConnectionState.CLOSED }

        val manual = scope.async { client.connect() }
        until { transport.attachCount() == 2 }
        firstListener.onClosed(1006, "late close")
        delay(30)
        assertFalse(manual.isCompleted, "the late close must not end the new attempt")

        transport.ack()
        manual.await()
        assertTrue(client.isConnected)
    }

    @Test
    fun `a connect that races the first attach completing joins it instead of attaching again`() = runBlocking {
        // The window is between connect's attached check and its attempt lookup,
        // so callers race the acknowledgement many times.
        repeat(300) { round ->
            val transport = RecordingTransport()
            val client = PyricBridgeClient(transport)
            until { transport.attachCount() == 1 }
            val callers = (1..8).map { scope.async { client.connect() } }
            transport.ack()
            until { callers.all { it.isCompleted } || transport.attachCount() > 1 }
            assertEquals(1, transport.attachCount(), "round $round sent ${transport.attachCount()} attach frames")
            callers.forEach { it.await() }
            client.disconnect()
        }
    }

    // The heartbeat (ADR-0019, amendment "clients send a heartbeat"). The fake
    // socket stays open and delivers nothing it is not told to, as a half-open
    // connection does.

    @Test
    fun `a ping is sent at attach, before the first interval, and then at each interval`() = runBlocking {
        val atAttach = client(heartbeatIntervalMs = 60_000L)
        atAttach.connect()
        until { bridge.current.pings() == 1 }
        val ping = bridge.ofType("ping").single()
        assertEquals(setOf("type", "id"), ping.keys)
        assertTrue(ping["id"] is String, "the ping carries an id")
        atAttach.disconnect()

        val ticking = client(heartbeatIntervalMs = 40L)
        ticking.connect()
        until { bridge.current.pings() >= 4 }
        val ids = bridge.current.attempted.filter { it["type"] == "ping" }.map { it["id"] }
        assertEquals(ids.size, ids.toSet().size, "each ping has its own id")
    }

    @Test
    fun `a socket silent for the liveness timeout is a drop that fails in-flight operations once and reconnects`() = runBlocking {
        val client = client(retryDelayMs = 100L, heartbeatIntervalMs = 40L, livenessTimeoutMs = 300L)
        client.connect()
        val attachedAt = System.nanoTime()
        val silent = bridge.current
        val pending = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        until { bridge.opsNamed("setDoc").size == 1 }
        val sentId = bridge.opsNamed("setDoc").single()["id"]

        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        val silentMs = (System.nanoTime() - attachedAt) / 1_000_000
        assertTrue(silentMs >= 250, "dropped after ${silentMs}ms, before the liveness timeout")
        assertFalse(silent.open, "the client closes the silent socket")
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { pending.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(error.message!!.contains("connection was lost"), error.message)

        bridge.answerPings = true
        until { bridge.connectCalls.get() >= 2 && client.isConnected }
        assertEquals("session-1", bridge.ofType("attach").last()["clientSessionId"])
        delay(50)
        assertEquals(1, bridge.ofType("worker-op").count { it["id"] == sentId })
    }

    @Test
    fun `an operation issued after a silent drop is held and sent once after re-attach`() = runBlocking {
        val client = client(heartbeatIntervalMs = 40L, livenessTimeoutMs = 200L)
        client.connect()
        bridge.refuseConnections = true
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }

        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(50)
        assertTrue(bridge.opsNamed("setDoc").isEmpty())
        assertFalse(held.isCompleted, "a held operation neither fails nor is sent")

        bridge.answerPings = true
        bridge.refuseConnections = false
        until { bridge.opsNamed("setDoc").size == 1 }
        val sent = bridge.opsNamed("setDoc").single()
        assertTrue(
            bridge.current.attempted.any { it["type"] == "worker-op" && it["id"] == sent["id"] },
            "the held operation is sent on the new socket"
        )
        respond(sent, "done")
        assertEquals("done", held.await())
        delay(50)
        assertEquals(1, bridge.opsNamed("setDoc").size)
    }

    @Test
    fun `pongs keep the client attached past the liveness timeout`() = runBlocking {
        bridge.answerPings = true
        val client = client(heartbeatIntervalMs = 40L, livenessTimeoutMs = 300L)
        client.connect()
        delay(900)
        assertEquals(BridgeConnectionState.ATTACHED, client.connectionState)
        assertEquals(1, bridge.connectCalls.get())
        assertTrue(bridge.current.pings() >= 5, "sent ${bridge.current.pings()} pings")
    }

    @Test
    fun `any frame from the bridge counts as traffic, not only a pong`() = runBlocking {
        val client = client(heartbeatIntervalMs = 40L, livenessTimeoutMs = 300L)
        client.connect()
        val socket = bridge.current
        repeat(18) {
            socket.deliver(mapOf("type" to "worker-event", "event" to "unrelated"))
            delay(50)
        }
        assertEquals(BridgeConnectionState.ATTACHED, client.connectionState)
        assertEquals(1, bridge.connectCalls.get())
    }

    @Test
    fun `no ping reaches a socket after it drops or after disconnect`() = runBlocking {
        bridge.answerPings = true
        val client = client(heartbeatIntervalMs = 20L)
        client.connect()
        val first = bridge.current
        until { first.pings() >= 2 }
        first.drop()
        // A ping that passed the current-socket check just before the drop may
        // still be on its way to the socket; it lands within this pause.
        delay(20)
        val pingsAtDrop = first.pings()

        until { bridge.sockets.size == 2 && client.isConnected }
        val second = bridge.current
        until { second.pings() >= 2 }
        delay(100)
        assertEquals(pingsAtDrop, first.pings(), "the dropped socket was pinged")

        client.disconnect()
        delay(20)
        val pingsAtDisconnect = second.pings()
        delay(100)
        assertEquals(pingsAtDisconnect, second.pings(), "a disconnected client pinged")
    }

    @Test
    fun `a client on a supplied transport closes on silence and fails its in-flight operations`() = runBlocking {
        val transport = RecordingTransport()
        val client = PyricBridgeClient(transport).also { clients.add(it) }
        client.heartbeatIntervalMs = 40L
        client.livenessTimeoutMs = 200L
        until { transport.attachCount() == 1 }
        transport.ack()
        client.connect()
        val pending = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        until { transport.count("worker-op") == 1 }

        until { client.connectionState == BridgeConnectionState.CLOSED }
        assertTrue(transport.count("ping") >= 1, "the client pinged before it closed")
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { pending.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("The Pyric bridge sent nothing for 45 seconds, so the connection is treated as lost.", error.message)
    }
}

/** A supplied transport that records every listener the client installs. */
private class RecordingTransport : BridgeTransport {
    val listeners = CopyOnWriteArrayList<BridgeListener>()
    private val sent = CopyOnWriteArrayList<Map<String, Any?>>()

    fun attachCount(): Int = count("attach")

    fun count(type: String): Int = sent.count { it["type"] == type }

    fun ack() {
        listeners.last().onMessage("""{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"session-1"}""")
    }

    override fun send(text: String): Boolean {
        sent.add(JsonCodec.decodeMap(text))
        return true
    }

    override fun close(code: Int, reason: String?): Boolean = true

    override fun setListener(listener: BridgeListener) {
        listeners.add(listener)
    }
}
