package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class RulesDenialListenerTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        FirebaseFirestore.clearInstancesForTest()
        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"] as? String) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String

                    if (method == "getDoc") {
                        // Simulate rules permission denial from sandbox
                        val res = mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to false,
                            "error" to mapOf(
                                "code" to "permission-denied",
                                "message" to "Missing or insufficient permissions.",
                                "denialContext" to mapOf(
                                    "rule" to mapOf(
                                        "file" to "firestore.rules",
                                        "line" to 14,
                                        "col" to 5,
                                        "citation" to "firestore.rules:14:5",
                                        "expression" to "request.auth != null"
                                    ),
                                    "auth" to mapOf("uid" to null),
                                    "reasons" to listOf("false for 'read' @ L14")
                                )
                            )
                        )
                        transport.sendToClient(JsonCodec.encodeToString(res))
                    } else {
                        val res = mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to emptyMap<String, Any?>()
                        )
                        transport.sendToClient(JsonCodec.encodeToString(res))
                    }
                }
            }
        }

        val options = FirebaseOptions.Builder()
            .setApiKey("test-api-key")
            .setApplicationId("test-app-id")
            .setProjectId("test-project-id")
            .build()
        app = FirebaseApp.initializeApp("test-denial-app", options)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)")
    }

    @AfterEach
    fun tearDown() {
        firestore.terminate()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun testRulesDenialListenerReceivesDenialOnGetDoc() {
        val denials = CopyOnWriteArrayList<Pair<FirebaseFirestoreException, Map<String, Any?>>>()
        val registration = firestore.addRulesDenialListener { exception, context ->
            denials.add(exception to context)
        }

        try {
            Tasks.await(firestore.document("secrets/doc1").get())
        } catch (_: ExecutionException) {
            // Expected PERMISSION_DENIED
        }

        // Wait briefly for firestoreScope to collect denial
        Thread.sleep(150)

        assertEquals(1, denials.size)
        val (ex, ctx) = denials[0]
        assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, ex.code)
        assertNotNull(ctx["rule"])
        @Suppress("UNCHECKED_CAST")
        val ruleMap = ctx["rule"] as Map<String, Any?>
        assertEquals("firestore.rules:14:5", ruleMap["citation"])

        // Unregister listener
        registration.remove()

        // Trigger another denial
        try {
            Tasks.await(firestore.document("secrets/doc2").get())
        } catch (_: ExecutionException) {
            // Expected
        }
        Thread.sleep(150)

        // Should still only have 1 denial recorded
        assertEquals(1, denials.size)
    }

    @Test
    fun testExplicitNotifyRulesDenial() {
        val denials = CopyOnWriteArrayList<Pair<FirebaseFirestoreException, Map<String, Any?>>>()
        firestore.addRulesDenialListener { exception, context ->
            denials.add(exception to context)
        }

        val manualContext = mapOf<String, Any?>(
            "reasons" to listOf("Manual rejection"),
            "failedFields" to listOf("secretKey")
        )
        val ex = FirebaseFirestoreException(
            "Test denial",
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            denialContext = manualContext
        )

        firestore.notifyRulesDenial(ex)

        assertEquals(1, denials.size)
        assertEquals("secretKey", (denials[0].second["failedFields"] as? List<*>)?.get(0))
    }
}
