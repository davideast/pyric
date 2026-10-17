package dev.pyric.database

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.FakeReconnectBridge
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

/**
 * Writes from one thread reach the bridge in the order the app issued them, as
 * they do on Android, where every operation runs on the Repo's run loop. The
 * presence sample depends on it: `onDisconnect().setValue("offline")` must reach
 * the host before `setValue("online")` (#1026).
 */
class WriteOrderTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var database: FirebaseDatabase

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "write-order-app",
            FirebaseOptions.Builder()
                .setProjectId("order-project")
                .setApiKey("order-key")
                .setApplicationId("order-app-id")
                .build()
        )
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        database = FirebaseDatabase(client, app, "https://order-project-default-rtdb.firebaseio.com")
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `presence writes issued while attached reach the socket in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }

        val expected = issuePresencePairs()
        until { presenceFrames().size == expected.size }

        assertEquals(expected, presenceFrames())
    }

    @Test
    fun `presence writes held during a reconnect are sent in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }

        val expected = issuePresencePairs()
        delay(50)
        bridge.refuseConnections = false
        until { presenceFrames().size == expected.size }

        assertEquals(expected, presenceFrames())
    }

    @Test
    fun `every write method issued while attached reaches the socket in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }

        val expected = mutableListOf<String>()
        repeat(MIXED_ROUNDS) { round -> expected += issueEveryWrite(database.getReference("mixed/$round")) }
        until { writeMethods().size == expected.size }

        assertEquals(expected, writeMethods())
    }

    /** The presence sample, [PAIRS] times from this one thread. Returns the frames it expects, in order. */
    private fun issuePresencePairs(): List<String> {
        val status = database.getReference(PRESENCE)
        val expected = mutableListOf<String>()
        repeat(PAIRS) { i ->
            status.onDisconnect().setValue("offline-$i")
            status.setValue("online-$i")
            expected += "rtdb.onDisconnectSet:offline-$i"
            expected += "rtdb.set:online-$i"
        }
        return expected
    }

    /** Calls each Realtime Database write once. Returns the methods it expects, in order. */
    private fun issueEveryWrite(ref: DatabaseReference): List<String> {
        val onDisconnect = ref.onDisconnect()
        onDisconnect.setValue("a")
        onDisconnect.setValue("a", 1)
        onDisconnect.updateChildren(mapOf("x" to 1))
        onDisconnect.removeValue()
        onDisconnect.cancel()
        ref.setValue("b")
        ref.setValue("b", 2)
        ref.setPriority(3)
        ref.updateChildren(mapOf("y" to 2))
        ref.removeValue()
        ref.runTransaction(IgnoredTransaction)
        return listOf(
            "rtdb.onDisconnectSet",
            "rtdb.onDisconnectSet",
            "rtdb.onDisconnectUpdate",
            "rtdb.onDisconnectRemove",
            "rtdb.onDisconnectCancel",
            "rtdb.set",
            "rtdb.setWithPriority",
            "rtdb.setPriority",
            "rtdb.update",
            "rtdb.remove",
            "rtdb.get"
        )
    }

    private object IgnoredTransaction : Transaction.Handler {
        override fun doTransaction(currentData: MutableData): Transaction.Result = Transaction.abort()
        override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {}
    }

    @Suppress("UNCHECKED_CAST")
    private fun opOf(frame: Map<String, Any?>): Map<String, Any?>? =
        if (frame["type"] == "worker-op") frame["op"] as? Map<String, Any?> else null

    private fun isPresenceWrite(op: Map<String, Any?>): Boolean =
        op["path"] == PRESENCE && op["method"] in PRESENCE_METHODS

    /** The presence writes on the current socket, as `method:value`. */
    private fun presenceFrames(): List<String> =
        bridge.sockets.last().attempted
            .mapNotNull(::opOf)
            .filter(::isPresenceWrite)
            .map { "${it["method"]}:${it["value"]}" }

    private fun isMixedWrite(op: Map<String, Any?>): Boolean =
        (op["path"] as? String)?.startsWith("mixed/") == true

    private fun writeMethods(): List<String> =
        bridge.sockets.last().attempted
            .mapNotNull(::opOf)
            .filter(::isMixedWrite)
            .map { it["method"] as String }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) delay(5)
        }
    }

    private companion object {
        const val PRESENCE = "status/u1"
        const val PAIRS = 1000
        const val MIXED_ROUNDS = 200
        val PRESENCE_METHODS = setOf("rtdb.onDisconnectSet", "rtdb.set")
    }
}
