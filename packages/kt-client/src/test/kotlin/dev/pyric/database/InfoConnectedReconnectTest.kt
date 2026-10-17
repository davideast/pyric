package dev.pyric.database

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.FakeReconnectBridge
import dev.pyric.bridge.FakeReconnectSocket
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * `.info/connected` across a dropped bridge connection (ADR-0019, amendment
 * "every client serves `.info` locally"). An app that re-arms its presence when
 * the value turns true must reach the host on the new socket, after the restore.
 */
class InfoConnectedReconnectTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var database: FirebaseDatabase

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "info-connected-app",
            FirebaseOptions.Builder()
                .setProjectId("info-project")
                .setApiKey("info-key")
                .setApplicationId("info-app-id")
                .build()
        )
    }

    /** Starts the client, which connects at once, after the test has set up the bridge. */
    private fun start() {
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        database = FirebaseDatabase(client, app, "https://info-project-default-rtdb.firebaseio.com")
    }

    @AfterEach
    fun tearDown() {
        if (::client.isInitialized) runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `connected reports false, true, false on a drop, then true on re-attach, with no repeated value`() = runBlocking {
        bridge.autoAck = false
        start()
        val seen = observeConnected()
        until { seen == listOf(false) && bridge.ofType("attach").size == 1 }

        bridge.autoAck = true
        ackAttach(bridge.current)
        until { seen == listOf(false, true) }

        bridge.refuseConnections = true
        bridge.current.drop()
        until { seen == listOf(false, true, false) }
        // Several refused attempts run while the client stays interrupted.
        until { bridge.connectCalls.get() >= 4 }

        bridge.refuseConnections = false
        until { seen == listOf(false, true, false, true) }
        delay(50)
        assertEquals(listOf(false, true, false, true), seen)
        assertNoInfoFrames()
    }

    @Test
    fun `a presence re-arm issued on true is sent on the new socket after the replayed listeners and the held operation`() = runBlocking {
        start()
        listen("rooms/a")
        listen("rooms/c")
        rearmPresenceOnConnected()
        until { bridge.subsFor("rooms/c").size == 1 && bridge.opsNamed("rtdb.onDisconnectSet").size == 1 && presenceWrites().size == 1 }

        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }
        database.getReference("rooms/b").setValue("held")
        delay(30)

        // Holds the replay between its two frames, so a re-arm that skipped the
        // held queue would reach the socket ahead of the second one.
        bridge.onFrame = { frame -> if (isReplayOf("rooms/a", frame)) Thread.sleep(100) }
        bridge.refuseConnections = false
        until {
            bridge.subsFor("rooms/c").size == 2 &&
                bridge.opsNamed("rtdb.onDisconnectSet").size == 2 &&
                presenceWrites().size == 2
        }

        val second = bridge.sockets.last().attempted
        val heldAt = second.indexOfFirst { opPath(it, "rtdb.set") == "rooms/b" }
        val rearmAt = second.indexOfFirst { opPath(it, "rtdb.onDisconnectSet") == PRESENCE }
        val onlineAt = second.indexOfFirst { opPath(it, "rtdb.set") == PRESENCE }
        assertTrue(subAt(second, "rooms/c") < heldAt, "the held operation follows the listener replay")
        assertTrue(heldAt in 0 until rearmAt, "the re-arm follows the held operation")
        assertTrue(heldAt in 0 until onlineAt, "the presence write follows the held operation")
        assertNoInfoFrames()
    }

    @Test
    fun `a presence re-arm on a replaced host is sent after the Auth restore`() = runBlocking {
        start()
        client.restoreAuth = { op -> op("auth.restorePortSession", mapOf("uid" to "u1", "tenantId" to null)) }
        listen("rooms/a")
        rearmPresenceOnConnected()
        until { bridge.subsFor("rooms/a").size == 1 && bridge.opsNamed("rtdb.onDisconnectSet").size == 1 && presenceWrites().size == 1 }

        bridge.hostInstanceId = "host-b"
        bridge.current.drop()
        until { bridge.opsNamed("auth.restorePortSession").size == 1 }
        delay(30)
        assertEquals(1, bridge.opsNamed("rtdb.onDisconnectSet").size, "no re-arm before the Auth restore answers")

        val restore = bridge.opsNamed("auth.restorePortSession").single()
        bridge.current.deliver(mapOf("type" to "worker-res", "id" to restore["id"], "ok" to true, "value" to mapOf("uid" to "u1")))
        until { bridge.opsNamed("rtdb.onDisconnectSet").size == 2 }

        val second = bridge.sockets.last().attempted
        val restoreAt = second.indexOfFirst { isOp(it, "auth.restorePortSession") }
        val rearmAt = second.indexOfFirst { opPath(it, "rtdb.onDisconnectSet") == PRESENCE }
        assertTrue(restoreAt in 0 until subAt(second, "rooms/a"), "the listener replay follows the Auth restore")
        assertTrue(subAt(second, "rooms/a") < rearmAt, "the re-arm follows the listener replay")
        assertNoInfoFrames()
    }

    private fun observeConnected(): List<Boolean> {
        val seen = CopyOnWriteArrayList<Boolean>()
        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                seen.add(snapshot.getValue(Boolean::class.java) == true)
            }
            override fun onCancelled(error: DatabaseError) {}
        })
        return seen
    }

    /** The Firebase presence sample: on every true, register the onDisconnect again, then write online. */
    private fun rearmPresenceOnConnected() {
        val status = database.getReference(PRESENCE)
        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (snapshot.getValue(Boolean::class.java) != true) return
                status.onDisconnect().setValue("offline")
                status.setValue("online")
            }
            override fun onCancelled(error: DatabaseError) {}
        })
    }

    private fun listen(path: String) {
        database.getReference(path).addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {}
        })
    }

    private fun ackAttach(socket: FakeReconnectSocket) {
        val attach = socket.attempted.last { it["type"] == "attach" }
        socket.deliver(
            mapOf(
                "type" to "attach-ack",
                "protocol" to 1,
                "peerConnected" to true,
                "clientSessionId" to (attach["clientSessionId"] as? String ?: "session-1"),
                "hostInstanceId" to bridge.hostInstanceId
            )
        )
    }

    private fun presenceWrites(): List<Map<String, Any?>> =
        bridge.opsNamed("rtdb.set").filter { opPath(it, "rtdb.set") == PRESENCE }

    @Suppress("UNCHECKED_CAST")
    private fun opOf(frame: Map<String, Any?>): Map<String, Any?>? =
        if (frame["type"] == "worker-op") frame["op"] as? Map<String, Any?> else null

    private fun isOp(frame: Map<String, Any?>, method: String): Boolean = opOf(frame)?.get("method") == method

    @Suppress("UNCHECKED_CAST")
    private fun opPath(frame: Map<String, Any?>, method: String): Any? {
        if (!isOp(frame, method)) return null
        return (opOf(frame)?.get("params") as? Map<String, Any?>)?.get("path") ?: opOf(frame)?.get("path")
    }

    @Suppress("UNCHECKED_CAST")
    private fun subPath(frame: Map<String, Any?>): Any? {
        if (frame["type"] != "worker-sub") return null
        val target = (frame["sub"] as? Map<String, Any?>)?.get("target") as? Map<String, Any?>
        return target?.get("path")
    }

    private fun subAt(frames: List<Map<String, Any?>>, path: String): Int =
        frames.indexOfFirst { subPath(it) == path }

    private fun isReplayOf(path: String, frame: Map<String, Any?>): Boolean =
        subPath(frame) == path && bridge.subsFor(path).size > 1

    private fun assertNoInfoFrames() {
        val infoFrames = bridge.frames.filter { it.toString().contains(".info") }
        assertTrue(infoFrames.isEmpty(), "no .info frame reaches the host: $infoFrames")
    }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) delay(5)
        }
    }

    private companion object {
        const val PRESENCE = "status/u1"
    }
}
