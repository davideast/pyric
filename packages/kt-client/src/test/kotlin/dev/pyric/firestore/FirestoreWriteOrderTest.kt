package dev.pyric.firestore

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
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
 * Firestore writes from one thread reach the bridge in the order the app issued
 * them, as the production SDK sends its local mutation queue in batch order.
 * `doc.set(x)` then `doc.update(y)` without awaiting is ordinary app code: if the
 * update reaches the host first it fails with NOT_FOUND, or the set overwrites it (#1032).
 */
class FirestoreWriteOrderTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "firestore-write-order-app",
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
        firestore = FirebaseFirestore(client, app, "(default)")
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `set then update issued while attached reach the socket in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }

        val expected = issueSetUpdatePairs()
        until { pairFrames().size == expected.size }

        assertEquals(expected, pairFrames())
    }

    @Test
    fun `set then update held during a reconnect are sent in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        bridge.refuseConnections = true
        bridge.current.drop()
        until { client.connectionState == BridgeConnectionState.INTERRUPTED }

        val expected = issueSetUpdatePairs()
        delay(50)
        bridge.refuseConnections = false
        until { pairFrames().size == expected.size }

        assertEquals(expected, pairFrames())
    }

    @Test
    fun `every write method issued while attached reaches the socket in call order`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }

        val expected = mutableListOf<String>()
        repeat(MIXED_ROUNDS) { round -> expected += issueEveryWrite(firestore.document("mixed/r$round")) }
        until { writeMethods().size == expected.size }

        assertEquals(expected, writeMethods())
    }

    /** `set` then `update` on one document, [PAIRS] times from this one thread. Returns the frames it expects, in order. */
    private fun issueSetUpdatePairs(): List<String> {
        val doc = firestore.document(PAIR_DOC)
        val expected = mutableListOf<String>()
        repeat(PAIRS) { i ->
            doc.set(mapOf("v" to "set-$i"))
            doc.update(mapOf("v" to "update-$i"))
            expected += "setDoc:set-$i"
            expected += "updateDoc:update-$i"
        }
        return expected
    }

    /** Calls each Firestore write once. Returns the methods it expects, in order. */
    private fun issueEveryWrite(doc: DocumentReference): List<String> {
        doc.set(mapOf("a" to 1))
        doc.set(mapOf("a" to 2), SetOptions.merge())
        doc.set(mapOf("a" to 3), SetOptions.mergeFields("a"))
        doc.update(mapOf("b" to 1))
        doc.update("b", 2)
        doc.delete()
        firestore.batch().set(doc, mapOf("c" to 1)).commit()
        firestore.runBatch { it.update(doc, mapOf("c" to 2)) }
        doc.collection("items").add(mapOf("d" to 1))
        return listOf(
            "setDoc",
            "setDoc",
            "setDoc",
            "updateDoc",
            "updateDoc",
            "deleteDoc",
            "batchCommit",
            "batchCommit",
            "setDoc"
        )
    }

    @Suppress("UNCHECKED_CAST")
    private fun opOf(frame: Map<String, Any?>): Map<String, Any?>? =
        if (frame["type"] == "worker-op") frame["op"] as? Map<String, Any?> else null

    /** The document a write targets; a batch names it in its first write. */
    @Suppress("UNCHECKED_CAST")
    private fun pathOf(op: Map<String, Any?>): String? =
        (op["path"] as? String) ?: ((op["writes"] as? List<Map<String, Any?>>)?.firstOrNull()?.get("path") as? String)

    @Suppress("UNCHECKED_CAST")
    private fun valueOf(op: Map<String, Any?>): Any? = (op["data"] as? Map<String, Any?>)?.get("v")

    /** The set and update frames for [PAIR_DOC] on the current socket, as `method:value`. */
    private fun pairFrames(): List<String> =
        bridge.sockets.last().attempted
            .mapNotNull(::opOf)
            .filter { pathOf(it) == PAIR_DOC && it["method"] in PAIR_METHODS }
            .map { "${it["method"]}:${valueOf(it)}" }

    private fun writeMethods(): List<String> =
        bridge.sockets.last().attempted
            .mapNotNull(::opOf)
            .filter { pathOf(it)?.startsWith("mixed/") == true }
            .map { it["method"] as String }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) {
            while (!condition()) delay(5)
        }
    }

    private companion object {
        const val PAIR_DOC = "rooms/r1"
        const val PAIRS = 1000
        const val MIXED_ROUNDS = 200
        val PAIR_METHODS = setOf("setDoc", "updateDoc")
    }
}
