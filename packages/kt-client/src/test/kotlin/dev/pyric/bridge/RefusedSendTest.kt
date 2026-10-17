package dev.pyric.bridge

import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.codecs.JsonCodec
import dev.pyric.database.FirebaseDatabase
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
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Stalls the first send that [matches] until the test decides its result:
 * false refuses the frame, true takes it without delivering it, as a socket
 * that has already dropped does.
 */
private class SendGate(val matches: (Map<String, Any?>) -> Boolean) {
    val reached = CountDownLatch(1)
    val result = CompletableFuture<Boolean>()

    fun awaitReached() {
        assertTrue(reached.await(10, TimeUnit.SECONDS), "the gated send was never reached")
    }
}

/** A socket from [FakeReconnectBridge] whose sends can be stalled by a [SendGate]. */
private class GatedSocket(
    private val inner: BridgeTransport,
    private val gates: GatedBridge
) : BridgeTransport {
    override fun send(text: String): Boolean {
        val gate = gates.claim(JsonCodec.decodeMap(text)) ?: return inner.send(text)
        gate.reached.countDown()
        return gate.result.get(10, TimeUnit.SECONDS)
    }

    override fun close(code: Int, reason: String?): Boolean = inner.close(code, reason)

    override fun setListener(listener: BridgeListener) = inner.setListener(listener)
}

private class GatedBridge(val bridge: FakeReconnectBridge) : BridgeTransportFactory {
    @Volatile private var gate: SendGate? = null

    fun arm(matches: (Map<String, Any?>) -> Boolean): SendGate = SendGate(matches).also { gate = it }

    @Synchronized
    fun claim(frame: Map<String, Any?>): SendGate? {
        val armed = gate ?: return null
        if (!armed.matches(frame)) return null
        gate = null
        return armed
    }

    override fun create(url: String, headers: Map<String, String>, listener: BridgeListener): BridgeTransport =
        GatedSocket(bridge.create(url, headers, listener), this)
}

/** A supplied transport that acknowledges the attach and refuses every operation. */
private class RefusingSuppliedTransport : BridgeTransport {
    @Volatile private var listener: BridgeListener? = null

    override fun send(text: String): Boolean {
        val frame = JsonCodec.decodeMap(text)
        if (frame["type"] == "attach") {
            Thread { listener?.onMessage("""{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"s"}""") }.start()
        }
        return frame["type"] != "worker-op"
    }

    override fun close(code: Int, reason: String?): Boolean = true

    override fun setListener(listener: BridgeListener) {
        this.listener = listener
    }
}

/**
 * A frame the transport refused never left the device, so it is held for the
 * reconnect instead of failing (ADR-0019, amendment 2026-10-17, #1033).
 * [FakeReconnectSocket.beginClosing] refuses sends the way OkHttp does on a
 * closing socket.
 */
class RefusedSendTest {
    private val bridge = FakeReconnectBridge()
    private val gates = GatedBridge(bridge)
    private val clients = mutableListOf<PyricBridgeClient>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun client(retryDelayMs: Long = 5L, holdTimeoutMs: Long? = null): PyricBridgeClient =
        PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = gates,
            reconnectDelayMs = { retryDelayMs }
        ).also { created ->
            if (holdTimeoutMs != null) created.holdTimeoutMs = holdTimeoutMs
            clients.add(created)
        }

    @AfterEach
    fun tearDown() {
        runBlocking { clients.forEach { it.disconnect() } }
        scope.cancel()
        bridge.shutdown()
        FirebaseApp.clearInstancesForTest()
    }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) delay(5)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun pathOf(frame: Map<String, Any?>): Any? = (frame["op"] as? Map<String, Any?>)?.get("path")

    private fun isOpOn(path: String): (Map<String, Any?>) -> Boolean =
        { it["type"] == "worker-op" && pathOf(it) == path }

    private fun opPaths(socket: FakeReconnectSocket): List<Any?> =
        socket.attempted.filter { it["type"] == "worker-op" }.map(::pathOf)

    private fun respond(socket: FakeReconnectSocket, frame: Map<String, Any?>, value: Any?) {
        socket.deliver(mapOf("type" to "worker-res", "id" to frame["id"], "ok" to true, "value" to value))
    }

    private fun respondToAllOps(socket: FakeReconnectSocket) {
        socket.attempted.filter { it["type"] == "worker-op" }.forEach { respond(socket, it, pathOf(it)) }
    }

    private fun newDatabase(client: PyricBridgeClient): FirebaseDatabase {
        FirebaseApp.clearInstancesForTest()
        val app = FirebaseApp.initializeApp(
            "refused-send-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("refused-project")
                .setApiKey("refused-key")
                .setApplicationId("refused-app-id")
                .build()
        )
        return FirebaseDatabase(client, app, "https://refused-project-default-rtdb.firebaseio.com")
    }

    @Test
    fun `a setValue refused by a closing socket is held and is the first operation on the new socket`() = runBlocking {
        val client = client()
        val database = newDatabase(client)
        client.connect()
        val closing = bridge.current

        closing.beginClosing()
        val write = database.getReference("status/u1").setValue("online")
        delay(30)
        assertFalse(write.isComplete, "a refused write neither fails nor is sent")

        closing.finishClosing(1006)
        until { bridge.sockets.size == 2 && client.isConnected }
        val reopened = bridge.current
        until { reopened.attempted.any { it["type"] == "worker-op" } }
        @Suppress("UNCHECKED_CAST")
        val first = reopened.attempted.first { it["type"] == "worker-op" }["op"] as Map<String, Any?>
        assertEquals("rtdb.set", first["method"])
        assertEquals("status/u1", first["path"])

        respondToAllOps(reopened)
        withTimeout(10_000) { write.await() }
        Unit
    }

    @Test
    fun `operations refused before the drop reach the new socket after the replayed listeners and ahead of those held after it`() = runBlocking {
        val client = client()
        client.connect()
        scope.launch { try { client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/listen")).collect {} } catch (_: Throwable) {} }
        until { bridge.subsFor("rooms/listen").size == 1 }
        val closing = bridge.current

        closing.beginClosing()
        val a1 = scope.async { client.op("setDoc", mapOf("path" to "rooms/a1")) }
        until { closing.attempted.any(isOpOn("rooms/a1")) }
        val a2 = scope.async { client.op("setDoc", mapOf("path" to "rooms/a2")) }
        delay(30)
        bridge.refuseConnections = true
        closing.finishClosing(1006)
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        val b = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)
        assertFalse(a1.isCompleted || a2.isCompleted || b.isCompleted, "held operations neither fail nor are sent")

        bridge.refuseConnections = false
        until { bridge.sockets.size == 2 && opPaths(bridge.current).size == 3 }
        val reopened = bridge.current
        assertEquals(listOf("rooms/a1", "rooms/a2", "rooms/b"), opPaths(reopened))
        val replayAt = reopened.attempted.indexOfFirst { it["type"] == "worker-sub" }
        val firstOpAt = reopened.attempted.indexOfFirst { it["type"] == "worker-op" }
        assertTrue(replayAt in 0 until firstOpAt, "the listener replay goes first")

        respondToAllOps(reopened)
        assertEquals("rooms/a1", a1.await())
        assertEquals("rooms/a2", a2.await())
        assertEquals("rooms/b", b.await())
    }

    @Test
    fun `a send that is refused after the drop was processed is held and sent after the re-attach`() = runBlocking {
        val client = client()
        client.connect()
        val first = bridge.current
        val gate = gates.arm(isOpOn("rooms/a"))
        val a = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        gate.awaitReached()

        bridge.refuseConnections = true
        first.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        gate.result.complete(false)
        delay(30)
        assertFalse(a.isCompleted, "a refused operation is held, not failed as lost")

        bridge.refuseConnections = false
        until { bridge.sockets.size == 2 && opPaths(bridge.current) == listOf("rooms/a") }
        respondToAllOps(bridge.current)
        assertEquals("rooms/a", a.await())
    }

    @Test
    fun `a send that the transport took after the drop was processed fails as lost and is never re-sent`() = runBlocking {
        val client = client()
        client.connect()
        val first = bridge.current
        val gate = gates.arm(isOpOn("rooms/a"))
        val a = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        gate.awaitReached()

        bridge.refuseConnections = true
        first.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        gate.result.complete(true)
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { a.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertTrue(error.message!!.contains("connection was lost"), error.message)

        bridge.refuseConnections = false
        until { bridge.sockets.size == 2 && client.isConnected }
        delay(50)
        assertTrue(opPaths(bridge.current).isEmpty(), "an operation that may have been sent is never re-sent")
    }

    @Test
    fun `a refusal that returns only after the re-attach is still sent ahead of an operation issued after it`() = runBlocking {
        val client = client(retryDelayMs = 0L)
        client.connect()
        val first = bridge.current
        val gate = gates.arm(isOpOn("rooms/a"))
        val a = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        gate.awaitReached()

        first.drop()
        until { bridge.sockets.size == 2 && client.isConnected }
        val b = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)
        gate.result.complete(false)

        val reopened = bridge.current
        until { opPaths(reopened).size == 2 }
        assertEquals(listOf("rooms/a", "rooms/b"), opPaths(reopened))
        respondToAllOps(reopened)
        assertEquals("rooms/a", a.await())
        assertEquals("rooms/b", b.await())
    }

    @Test
    fun `a refused operation fails with the close error when the close permits no retry, and nothing is sent`() = runBlocking {
        val client = client()
        client.connect()
        val closing = bridge.current

        closing.beginClosing()
        val a = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        delay(30)
        assertFalse(a.isCompleted, "a refused operation waits for the socket's close")

        closing.finishClosing(1008)
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { a.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("Bridge connection closed: closed by peer (1008)", error.message)
        assertEquals(BridgeConnectionState.CLOSED, client.connectionState)
        delay(50)
        assertEquals(1, bridge.ofType("attach").size, "a policy close is not retried")
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `a refused operation fails once with disconnected when the app disconnects`() = runBlocking {
        val client = client()
        client.connect()
        bridge.current.beginClosing()
        val a = scope.async { client.op("setDoc", mapOf("path" to "rooms/a")) }
        delay(30)
        assertFalse(a.isCompleted, "a refused operation waits for the socket's close")

        client.disconnect()
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { a.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("PyricBridgeClient disconnected.", error.message)
        assertTrue(bridge.ofType("worker-op").isEmpty())
    }

    @Test
    fun `a refused operation with no re-attach fails at the hold deadline measured from issue`() = runBlocking {
        val client = client(holdTimeoutMs = 200L)
        client.connect()
        bridge.current.beginClosing()

        val issuedAt = System.nanoTime()
        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { client.op("setDoc", mapOf("path" to "rooms/a")) }
        }
        val heldMs = (System.nanoTime() - issuedAt) / 1_000_000
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("The bridge connection was not restored within 10 seconds. The request was not sent.", error.message)
        assertTrue(heldMs in 180..2_000, "the operation was held for ${heldMs}ms, not until the deadline")
    }

    @Test
    fun `a refusal on a client built on one supplied transport fails as before`() = runBlocking {
        val client = PyricBridgeClient(RefusingSuppliedTransport()).also { clients.add(it) }
        client.connect()

        val error = assertThrows<FirebaseFirestoreException> {
            runBlocking { withTimeout(2_000) { client.op("setDoc", mapOf("path" to "rooms/a")) } }
        }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals("Failed to dispatch op to bridge: Failed to enqueue message to bridge transport.", error.message)
    }

    @Test
    fun `a refused Auth restore operation fails the restore, so the held operations fail without being sent`() = runBlocking {
        val client = client()
        client.restoreAuth = { op -> op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null)) }
        client.connect()
        gates.arm { it["type"] == "worker-op" }.result.complete(false)

        bridge.hostInstanceId = "host-b"
        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        val held = scope.async { client.op("setDoc", mapOf("path" to "rooms/b")) }
        delay(30)

        bridge.refuseConnections = false
        val error = assertThrows<FirebaseFirestoreException> { runBlocking { held.await() } }
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals(
            "The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent.",
            error.message
        )
        until { client.isConnected }
        delay(50)
        assertTrue(bridge.opsNamed("setDoc").isEmpty())
        assertTrue(bridge.opsNamed("auth.restorePortSession").isEmpty(), "the refused restore never reached the host")
    }
}
