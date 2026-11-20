package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestoreSettings
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.Date
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class FirestoreOfflineAndDocOpsParityTest {
    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        harness = ConformanceMockHarness()
    }

    @AfterEach
    fun tearDown() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `memory-only persistence does not retain cached documents across terminate and restart`() {
        harness.firestore.firestoreSettings = firestoreSettings {
            setPersistenceEnabled(false)
        }
        val docRef = harness.firestore.document("users/alice")
        Tasks.await(docRef.set(mapOf("name" to "Alice")), 5, TimeUnit.SECONDS)
        val cached = Tasks.await(docRef.get(Source.CACHE), 5, TimeUnit.SECONDS)
        assertTrue(cached.exists())
        assertTrue(cached.metadata.isFromCache)

        val bridge = harness.firestore.bridgeClient
        Tasks.await(harness.firestore.terminate(), 5, TimeUnit.SECONDS)
        val restarted = FirebaseFirestore.getInstance(harness.app, bridge)
        assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
            Tasks.await(restarted.document("users/alice").get(Source.CACHE), 5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `terminate aborts pending offline writes with ABORTED and completes waitForPendingWrites`() {
        val docRef = harness.firestore.document("users/bob")
        Tasks.await(harness.firestore.disableNetwork(), 5, TimeUnit.SECONDS)

        val pendingWrite = docRef.set(mapOf("status" to "offline"))
        val waitBarrier = harness.firestore.waitForPendingWrites()
        assertFalse(pendingWrite.isComplete)
        assertFalse(waitBarrier.isComplete)

        Tasks.await(harness.firestore.terminate(), 5, TimeUnit.SECONDS)
        Tasks.await(waitBarrier, 5, TimeUnit.SECONDS)
        assertFirestoreCode(FirebaseFirestoreException.Code.ABORTED) {
            Tasks.await(pendingWrite, 5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `Source DEFAULT falls back to cached projection when online bridge returns UNAVAILABLE`() {
        val transport = InMemoryBridgeTransport()
        val client = PyricBridgeClient(transport)
        var failReadsWithUnavailable = false
        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            when (msg["type"] as? String) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    if (method == "getDoc" && failReadsWithUnavailable) {
                        transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"unavailable","message":"Link down"}}"""
                        )
                    } else if (method == "setDoc") {
                        transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                    } else {
                        transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"u1","exists":true,"data":{"name":"CachedName"}}}"""
                        )
                    }
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "fallback-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-project")
                .setApiKey("key")
                .setApplicationId("1:1:android:fallback")
                .build()
        )
        val fs = FirebaseFirestore.getInstance(app, client)
        val docRef = fs.document("users/u1")
        Tasks.await(docRef.get(Source.SERVER), 5, TimeUnit.SECONDS)

        failReadsWithUnavailable = true
        val fallbackSnap = Tasks.await(docRef.get(Source.DEFAULT), 5, TimeUnit.SECONDS)
        assertTrue(fallbackSnap.exists())
        assertTrue(fallbackSnap.metadata.isFromCache)
        assertEquals("CachedName", fallbackSnap.getString("name"))

        assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
            Tasks.await(docRef.get(Source.SERVER), 5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun `offline projection handles rich types, DocumentReference resolution, and mixed String-FieldPath update varargs`() {
        val recordedOps = CopyOnWriteArrayList<Map<String, Any?>>()
        val transport = InMemoryBridgeTransport()
        val client = PyricBridgeClient(transport)
        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            when (msg["type"] as? String) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    recordedOps.add(op)
                    transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "wire-fields-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-project")
                .setApiKey("key")
                .setApplicationId("1:1:android:wirefields")
                .build()
        )
        val fs = FirebaseFirestore.getInstance(app, client)
        val docRef = fs.document("users/u2")
        val targetRef = fs.document("rooms/lobby")

        Tasks.await(fs.disableNetwork(), 5, TimeUnit.SECONDS)
        val w1 = docRef.set(
            mapOf(
                "score" to 1.5,
                "rawBytes" to byteArrayOf(1, 2, 3),
                "legacyDate" to Date(1_700_000_000_000L),
                "roomRef" to targetRef,
                "items" to arrayOf("x", "y")
            )
        )
        // Mixed String first arg + FieldPath vararg routes through segment-vector wire form
        val w2 = docRef.update(
            "score",
            FieldValue.increment(2.25),
            FieldPath.of("a.b", "c"),
            "segmented",
            "items",
            FieldValue.arrayRemove("x")
        )

        val localSnap = Tasks.await(docRef.get(Source.CACHE), 5, TimeUnit.SECONDS)
        assertTrue(localSnap.exists())
        assertTrue(localSnap.metadata.hasPendingWrites)
        assertEquals(3.75, localSnap.getDouble("score") ?: 0.0, 1e-9)
        assertArrayEquals(byteArrayOf(1, 2, 3), localSnap.getBlob("rawBytes")?.toBytes())
        assertTrue(localSnap.get("legacyDate") is Timestamp)
        val projectedRef = localSnap.getDocumentReference("roomRef")
        assertEquals("rooms/lobby", projectedRef?.path)
        assertSame(fs, projectedRef?.firestore)
        assertEquals("segmented", localSnap.get(FieldPath.of("a.b", "c")))
        assertEquals(listOf("y"), localSnap.get("items"))

        assertThrows(IllegalArgumentException::class.java) {
            docRef.update(FieldPath.of("score"), 10L, 12345, "bad-key-type")
        }

        Tasks.await(fs.enableNetwork(), 5, TimeUnit.SECONDS)
        Tasks.await(w1, 5, TimeUnit.SECONDS)
        Tasks.await(w2, 5, TimeUnit.SECONDS)

        assertEquals(2, recordedOps.size)
        assertEquals("setDoc", recordedOps[0]["method"])
        assertEquals("updateDoc", recordedOps[1]["method"])
        assertNull(recordedOps[1]["data"])
        @Suppress("UNCHECKED_CAST")
        val fieldsWire = recordedOps[1]["fields"] as List<Map<String, Any?>>
        assertEquals(listOf("score"), fieldsWire[0]["path"])
        assertEquals(listOf("a.b", "c"), fieldsWire[1]["path"])
        assertEquals(listOf("items"), fieldsWire[2]["path"])
    }

    private fun assertFirestoreCode(expected: FirebaseFirestoreException.Code, block: () -> Unit) {
        try {
            block()
            fail("Expected FirebaseFirestoreException($expected)")
        } catch (err: ExecutionException) {
            val cause = err.cause as? FirebaseFirestoreException
                ?: fail("Expected FirebaseFirestoreException cause, got: ${err.cause}")
            assertEquals(expected, cause.code)
        }
    }
}
