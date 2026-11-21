package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.firestoreSettings
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class FirestoreLifecycleAndValidationParityTest {
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
    fun `document rejects empty strings while collectionGroup allows empty string and rejects slashes`() {
        assertThrows(IllegalArgumentException::class.java) { harness.firestore.document("") }
        assertThrows(IllegalArgumentException::class.java) { harness.firestore.document("///") }
        assertEquals("", harness.firestore.collectionGroup("").collectionId)
        assertThrows(IllegalArgumentException::class.java) { harness.firestore.collectionGroup("users/items") }
        assertThrows(IllegalArgumentException::class.java) { harness.firestore.collection("users").document("") }
    }

    @Test
    fun `firestoreSettings locks against unequal mutation after operations start`() {
        val initial = firestoreSettings {
            setHost("127.0.0.1:7000")
            setSslEnabled(false)
            setPersistenceEnabled(true)
            setCacheSizeBytes(FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED)
        }
        harness.firestore.firestoreSettings = initial
        assertEquals(initial, harness.firestore.firestoreSettings)

        Tasks.await(harness.firestore.document("users/alice").get(), 5, TimeUnit.SECONDS)

        // Assigning equal settings remains permitted
        harness.firestore.firestoreSettings = FirebaseFirestoreSettings.Builder(initial).build()

        assertThrows(IllegalStateException::class.java) {
            harness.firestore.firestoreSettings = firestoreSettings {
                setHost("127.0.0.1:7001")
            }
        }
    }

    @Test
    fun `CollectionReference add propagates PERMISSION_DENIED instead of resolving DocumentReference`() {
        val transport = InMemoryBridgeTransport()
        val client = PyricBridgeClient(transport)
        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            when (msg["type"] as? String) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    transport.sendToClient(
                        """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"permission-denied","message":"Denied by rules"}}"""
                    )
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "denied-add-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-denied")
                .setApiKey("key")
                .setApplicationId("app")
                .build()
        )
        val db = FirebaseFirestore(client, app, "(default)")
        try {
            Tasks.await(db.collection("users").add(mapOf("name" to "Blocked")), 5, TimeUnit.SECONDS)
            fail("Expected PERMISSION_DENIED on CollectionReference.add")
        } catch (err: ExecutionException) {
            val fse = err.cause as? FirebaseFirestoreException
                ?: fail("Expected FirebaseFirestoreException cause, got: ${err.cause}")
            assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, fse.code)
        } finally {
            db.terminate()
        }
    }

    @Test
    fun `terminate evicts cached instance, completes snapshot flows cleanly, and preserves shared app bridge`() {
        val transport = InMemoryBridgeTransport()
        val sharedBridge = PyricBridgeClient(transport)
        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            when (msg["type"] as? String) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    transport.sendToClient(
                        """{"type":"worker-snap","subId":"$subId","value":{"id":"alice","path":"users/alice","exists":true,"data":{"json":"{\"name\":\"Alice\"}"}}}"""
                    )
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "shared-bridge-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-shared")
                .setApiKey("key")
                .setApplicationId("app")
                .build()
        )
        val auth = FirebaseAuth.getInstance(app, sharedBridge)
        val db = FirebaseFirestore.getInstance(app, sharedBridge)
        assertSame(auth.bridgeClient, db.bridgeClient)

        val firstEmitted = CountDownLatch(1)
        val flowDone = CountDownLatch(1)
        val scope = CoroutineScope(Dispatchers.IO)
        scope.launch {
            db.document("users/alice").snapshots().collect {
                firstEmitted.countDown()
            }
            flowDone.countDown()
        }

        try {
            assertTrue(firstEmitted.await(5, TimeUnit.SECONDS))
            Tasks.await(db.terminate(), 5, TimeUnit.SECONDS)
            assertTrue(flowDone.await(5, TimeUnit.SECONDS))
            assertFalse(sharedBridge.isDisposed)
            assertThrows(IllegalStateException::class.java) { db.document("users/alice") }

            val restarted = FirebaseFirestore.getInstance(app, sharedBridge)
            assertNotSame(db, restarted)
            Tasks.await(restarted.document("users/alice").set(mapOf("name" to "Restarted")), 5, TimeUnit.SECONDS)
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun `nested FieldValue sentinels inside array literals are rejected synchronously on writes`() {
        val doc = harness.firestore.document("users/alice")
        assertThrows(IllegalArgumentException::class.java) {
            doc.set(mapOf("items" to listOf(FieldValue.serverTimestamp())), SetOptions.merge())
        }
        assertThrows(IllegalArgumentException::class.java) {
            doc.update(mapOf("items" to listOf(FieldValue.delete())))
        }
        assertThrows(IllegalArgumentException::class.java) {
            harness.firestore.batch().update(doc, mapOf("items" to listOf(FieldValue.increment(1L))))
        }
    }
}
