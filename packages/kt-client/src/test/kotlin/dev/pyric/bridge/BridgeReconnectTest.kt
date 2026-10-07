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

/** One fake socket. [drop] ends it the way a lost connection does. */
class FakeReconnectSocket(
    private val bridge: FakeReconnectBridge,
    private val listener: BridgeListener
) : BridgeTransport {
    @Volatile var open = true
        private set

    override fun send(text: String): Boolean {
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

    fun record(frame: Map<String, Any?>, socket: FakeReconnectSocket) {
        frames.add(frame)
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
        attachTimeoutMs: Long = 5_000L
    ): PyricBridgeClient =
        PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            retryInitialConnection = retryInitialConnection,
            reconnectDelayMs = { retryDelayMs },
            attachTimeoutMs = attachTimeoutMs
        ).also { clients.add(it) }

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
    fun `an operation issued while the connection is interrupted fails at once with unavailable`() = runBlocking {
        val client = client()
        client.connect()
        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }

        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("getDoc", mapOf("path" to "rooms/a")) }
        }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `the first connection retries when asked to and an operation issued during a failed attempt fails once`() = runBlocking {
        bridge.refuseConnections = true
        val client = client(retryInitialConnection = true)
        val values = CopyOnWriteArrayList<Any?>()
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/a")).collect { values.add(it) } } catch (_: Throwable) {} }

        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("setDoc", mapOf("path" to "rooms/a")) }
        }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertFalse(client.isDisposed)

        bridge.refuseConnections = false
        until { client.isConnected }
        assertTrue(bridge.ofType("worker-op").isEmpty())
        until { bridge.subsFor("rooms/a").size == 1 }
        val subId = bridge.subsFor("rooms/a").single()["subId"]
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to mapOf("path" to "rooms/a", "exists" to false)))
        until { values.size == 1 }
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
}

/** A supplied transport that records every listener the client installs. */
private class RecordingTransport : BridgeTransport {
    val listeners = CopyOnWriteArrayList<BridgeListener>()
    private val sent = CopyOnWriteArrayList<Map<String, Any?>>()

    fun attachCount(): Int = sent.count { it["type"] == "attach" }

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
