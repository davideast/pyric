package dev.pyric.bridge

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.ai.FirebaseAI
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class BridgeDeliveryAndWireCodeRegressionTest {

    @Test
    fun `publishConnectionState updates synchronous observers before waking StateFlow collectors`() = runBlocking {
        val queue = BridgeDeliveryQueue()
        val hub = BridgeEventHub(queue)
        val observedBySync = AtomicReference(BridgeConnectionState.CONNECTING)
        val seenAtWake = CopyOnWriteArrayList<BridgeConnectionState>()
        hub.addConnectionStateObserver { state, _ ->
            observedBySync.set(state)
        }
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        try {
            repeat(50) {
                val ready = CountDownLatch(1)
                val job = scope.launch {
                    ready.countDown()
                    hub.connectionStates.first { it == BridgeConnectionState.ATTACHED }
                    seenAtWake.add(observedBySync.get())
                }
                assertTrue(ready.await(5, TimeUnit.SECONDS))
                hub.publishConnectionState(BridgeConnectionState.ATTACHED)
                withTimeout(5_000) { job.join() }
                hub.publishConnectionState(BridgeConnectionState.INTERRUPTED)
            }
            assertTrue(seenAtWake.all { it == BridgeConnectionState.ATTACHED }, "saw $seenAtWake")
        } finally {
            scope.cancel()
            queue.shutdown()
        }
    }

    @Test
    fun `K12 D6 policy close 1008 never leaks initial false across repeated runs`() = runBlocking {
        repeat(40) { idx ->
            FirebaseApp.clearInstancesForTest()
            FirebaseDatabase.clearInstancesForTest()
            val bridge = FakeReconnectBridge()
            val app = FirebaseApp.initializeApp(
                "k12-stress-$idx-${System.nanoTime()}",
                FirebaseOptions.Builder()
                    .setProjectId("contract-project")
                    .setApiKey("contract-key")
                    .setApplicationId("contract-app")
                    .build()
            )
            val client = PyricBridgeClient(
                url = "ws://127.0.0.1:5174/__pyric/sandbox",
                transportFactory = bridge,
                reconnectDelayMs = { 5L }
            )
            try {
                val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")
                withTimeout(10_000) {
                    client.connectionStates.first { it == BridgeConnectionState.ATTACHED }
                }
                val seen = CopyOnWriteArrayList<Any?>()
                val initialTrue = CountDownLatch(1)
                val cancelled = CountDownLatch(1)
                database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
                    override fun onDataChange(snapshot: DataSnapshot) {
                        seen.add(snapshot.value)
                        if (snapshot.value == true) initialTrue.countDown()
                    }
                    override fun onCancelled(error: DatabaseError) { cancelled.countDown() }
                })
                assertTrue(initialTrue.await(10, TimeUnit.SECONDS))
                bridge.current.drop(code = 1008)
                assertTrue(cancelled.await(10, TimeUnit.SECONDS))
                assertEquals(listOf<Any?>(true), seen.toList(), "iteration=$idx")
            } finally {
                client.disconnect()
                bridge.shutdown()
                FirebaseDatabase.clearInstancesForTest()
                FirebaseApp.clearInstancesForTest()
            }
        }
    }

    @Test
    fun `fromWireCode normalizes underscores and strips database and firestore prefixes`() {
        assertEquals(
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            FirebaseFirestoreException.Code.fromWireCode("PERMISSION_DENIED")
        )
        assertEquals(
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            FirebaseFirestoreException.Code.fromWireCode("database/permission-denied")
        )
        assertEquals(
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            FirebaseFirestoreException.Code.fromWireCode("firestore/permission-denied")
        )
        assertEquals(
            FirebaseFirestoreException.Code.FAILED_PRECONDITION,
            FirebaseFirestoreException.Code.fromWireCode("firestore/FAILED_PRECONDITION")
        )
    }

    @Test
    fun `subscription __error merges top-level denial extras and dispatches bare PERMISSION_DENIED`() = runBlocking {
        val bridge = FakeReconnectBridge()
        val subIdLatch = CountDownLatch(1)
        val capturedSubId = AtomicReference<String?>()
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                capturedSubId.set(frame["subId"] as? String)
                subIdLatch.countDown()
            }
        }
        val client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            withTimeout(10_000) {
                client.connectionStates.first { it == BridgeConnectionState.ATTACHED }
            }
            val denials = CopyOnWriteArrayList<FirebaseFirestoreException>()
            val denialLatch = CountDownLatch(1)
            client.addDenialObserver { ex ->
                denials.add(ex)
                denialLatch.countDown()
            }
            val subJob = scope.launch {
                try {
                    client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/secret")).collect {}
                } catch (_: Throwable) {}
            }
            assertTrue(subIdLatch.await(10, TimeUnit.SECONDS))
            val subId = capturedSubId.get()
            assertNotNull(subId)
            bridge.current.deliver(
                mapOf(
                    "type" to "worker-snap",
                    "subId" to subId,
                    "value" to mapOf(
                        "__error" to mapOf(
                            "code" to "PERMISSION_DENIED",
                            "message" to "Permission denied",
                            "denialContext" to mapOf("engine" to "rtdb"),
                            "remediation" to "Allow reads for members",
                            "repro" to mapOf("command" to "pyric verify"),
                            "queryProof" to mapOf("ok" to false)
                        )
                    )
                )
            )
            assertTrue(denialLatch.await(10, TimeUnit.SECONDS))
            assertEquals(1, denials.size)
            val denial = denials.single()
            assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, denial.code)
            @Suppress("UNCHECKED_CAST")
            val ctx = denial.denialContext as? Map<String, Any?>
            assertNotNull(ctx)
            assertEquals("Allow reads for members", ctx?.get("remediation"))
            assertNotNull(ctx?.get("repro"))
            assertNotNull(ctx?.get("queryProof"))
            withTimeout(5_000) { subJob.join() }
        } finally {
            scope.cancel()
            client.disconnect()
            bridge.shutdown()
        }
    }

    @Test
    fun `unary AI generateContent preserves aiEnvelope reason into typed InvalidAPIKeyException`() = runBlocking {
        FirebaseApp.clearInstancesForTest()
        val bridge = FakeReconnectBridge()
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                bridge.current.deliver(
                    mapOf(
                        "type" to "worker-res",
                        "id" to frame["id"],
                        "ok" to false,
                        "error" to mapOf(
                            "code" to "invalid-argument",
                            "message" to "API key not valid.",
                            "aiEnvelope" to mapOf(
                                "error" to mapOf(
                                    "code" to 400,
                                    "status" to "INVALID_ARGUMENT",
                                    "message" to "API key not valid.",
                                    "details" to listOf(
                                        mapOf(
                                            "@type" to "type.googleapis.com/google.rpc.ErrorInfo",
                                            "reason" to "API_KEY_INVALID"
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            }
        }
        val app = FirebaseApp.initializeApp(
            "ai-envelope-test-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("ai-project")
                .setApiKey("bad-key")
                .setApplicationId("ai-app")
                .build()
        )
        val client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        try {
            val ai = FirebaseAI.getInstance(app = app, bridgeClient = client)
            val model = ai.generativeModel("gemini-2.5-flash")
            val thrown = assertThrows<Exception> {
                model.generateContent("hi")
            }
            assertInstanceOf(InvalidAPIKeyException::class.java, thrown)
            Unit
        } finally {
            client.disconnect()
            bridge.shutdown()
            FirebaseApp.clearInstancesForTest()
        }
    }
}
