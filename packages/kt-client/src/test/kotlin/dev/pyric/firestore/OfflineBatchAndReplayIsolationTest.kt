package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class OfflineBatchAndReplayIsolationTest {

    private data class RecordedOp(
        val method: String,
        val params: Map<String, Any?>,
        val actAs: Map<String, Any?>?
    )

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    private val recordedOps = CopyOnWriteArrayList<RecordedOp>()

    @BeforeEach
    fun setUp() {
        recordedOps.clear()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        transport = InMemoryBridgeTransport()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"] as? String) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    transport.sendToClient(
                        JsonCodec.encodeToString(mapOf("type" to "worker-snap", "subId" to subId, "value" to null))
                    )
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    @Suppress("UNCHECKED_CAST")
                    val actAs = op["actAs"] as? Map<String, Any?>
                    recordedOps.add(RecordedOp(method, op, actAs))

                    val uid = actAs?.get("uid") as? String
                    val path = op["path"] as? String
                    if (path != null && path.startsWith("notes/alice-") && uid != "alice-uid") {
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to false,
                                    "error" to mapOf(
                                        "code" to "permission-denied",
                                        "message" to "Missing or insufficient permissions."
                                    )
                                )
                            )
                        )
                    } else if (method == "getDoc" && path == "notes/existing") {
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to true,
                                    "value" to mapOf(
                                        "id" to "existing",
                                        "path" to "notes/existing",
                                        "exists" to true,
                                        "data" to mapOf("title" to "Initial", "keep" to true)
                                    )
                                )
                            )
                        )
                    } else {
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to emptyMap<String, Any?>())
                            )
                        )
                    }
                }
            }
        }

        bridgeClient = PyricBridgeClient(transport)
        val options = FirebaseOptions.Builder()
            .setApiKey("test-api-key")
            .setApplicationId("test-app-id")
            .setProjectId("test-project-id")
            .build()
        app = FirebaseApp.initializeApp("test-kt-offline-batch-replay", options)
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)
    }

    @AfterEach
    fun tearDown() {
        firestore.terminate()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun writeBatchStagesOfflineAndFlushesAtomicallyOnEnableNetwork() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        val existingRef = firestore.document("notes/existing")
        val createdRef = firestore.document("notes/created")
        val mergedRef = firestore.document("notes/merged")

        // Prime cache for notes/existing while online.
        assertEquals("Initial", Tasks.await(existingRef.get(Source.SERVER)).getString("title"))
        recordedOps.clear()

        Tasks.await(firestore.disableNetwork())

        val commitTask = firestore.batch()
            .set(createdRef, mapOf("title" to "Offline Created"))
            .set(mergedRef, mapOf("tag" to "draft"), SetOptions.merge())
            .update(existingRef, mapOf("title" to "Updated Offline"))
            .commit()

        assertFalse(commitTask.isComplete, "Offline batch commit should stay pending until enableNetwork")
        assertTrue(recordedOps.none { it.method == "batchCommit" }, "Offline WriteBatch must not send batchCommit RPC")

        val createdSnap = Tasks.await(createdRef.get(Source.CACHE))
        assertTrue(createdSnap.exists())
        assertEquals("Offline Created", createdSnap.getString("title"))
        assertTrue(createdSnap.metadata.hasPendingWrites())
        assertTrue(createdSnap.metadata.isFromCache())

        val existingSnap = Tasks.await(existingRef.get(Source.CACHE))
        assertTrue(existingSnap.exists())
        assertEquals("Updated Offline", existingSnap.getString("title"))
        assertEquals(true, existingSnap.getBoolean("keep"))
        assertTrue(existingSnap.metadata.hasPendingWrites())

        Tasks.await(firestore.enableNetwork(), 5, TimeUnit.SECONDS)
        Tasks.await(commitTask, 5, TimeUnit.SECONDS)

        val batchOps = recordedOps.filter { it.method == "batchCommit" }
        assertEquals(1, batchOps.size, "Expected one atomic batchCommit RPC on reconnect")
        assertEquals("alice-uid", batchOps[0].actAs?.get("uid"))
        @Suppress("UNCHECKED_CAST")
        val writes = batchOps[0].params["writes"] as List<Map<String, Any?>>
        assertEquals(3, writes.size)

        val flushedSnap = Tasks.await(createdRef.get(Source.CACHE))
        assertTrue(flushedSnap.exists())
        assertFalse(flushedSnap.metadata.hasPendingWrites())
    }

    @Test
    fun runTransactionFailsUnavailableWhenOfflineWithoutCallingBridge() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        Tasks.await(firestore.disableNetwork())
        recordedOps.clear()

        val callbackRuns = AtomicInteger(0)
        val txnTask = firestore.runTransaction { txn ->
            callbackRuns.incrementAndGet()
            txn.get(firestore.document("notes/existing"))
            "ok"
        }

        val err = assertThrows(ExecutionException::class.java) {
            Tasks.await(txnTask, 5, TimeUnit.SECONDS)
        }
        val fsErr = err.cause as? FirebaseFirestoreException
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, fsErr?.code)
        assertEquals(0, callbackRuns.get(), "Offline transaction callback should not execute")
        assertTrue(
            recordedOps.none { it.method == "getDoc" || it.method == "txnCommit" },
            "Offline runTransaction must not send bridge RPCs"
        )
    }

    @Test
    fun aggregateCountAndSumFailUnavailableWhenOfflineWithoutCallingBridge() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        Tasks.await(firestore.disableNetwork())
        recordedOps.clear()

        val countErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(firestore.collection("notes").count().get(), 5, TimeUnit.SECONDS)
        }
        assertEquals(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            (countErr.cause as? FirebaseFirestoreException)?.code
        )

        val multiAggErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(
                firestore.collection("notes")
                    .aggregate(
                        AggregateField.count(),
                        AggregateField.sum("score"),
                        AggregateField.average("score")
                    )
                    .get(),
                5,
                TimeUnit.SECONDS
            )
        }
        assertEquals(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            (multiAggErr.cause as? FirebaseFirestoreException)?.code
        )

        assertTrue(
            recordedOps.none { it.method == "count" || it.method == "aggregate" },
            "Offline aggregate queries must not send count or aggregate RPCs"
        )
    }

    @Test
    fun enableNetworkAbortsCrossUserStagedWritesWithoutBridgeReplayOrDenials() {
        val denials = CopyOnWriteArrayList<FirebaseFirestoreException>()
        val denialReg = firestore.addRulesDenialListener { ex, _ ->
            denials.add(ex)
        }

        try {
            // Alice goes offline and stages both a single-doc write and a WriteBatch.
            auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
            Tasks.await(firestore.disableNetwork())
            recordedOps.clear()

            val aliceDoc = firestore.document("notes/alice-private")
            val aliceBatchDoc1 = firestore.document("notes/alice-batch-1")
            val aliceBatchDoc2 = firestore.document("notes/alice-batch-2")

            val aliceSingleTask = aliceDoc.set(mapOf("owner" to "alice", "secret" to "v1"))
            val aliceBatchTask = firestore.batch()
                .set(aliceBatchDoc1, mapOf("owner" to "alice"))
                .set(aliceBatchDoc2, mapOf("owner" to "alice"))
                .commit()

            assertFalse(aliceSingleTask.isComplete)
            assertFalse(aliceBatchTask.isComplete)
            assertTrue(recordedOps.isEmpty())

            // Switch to Bob while still offline; Bob stages his own document.
            auth.setAuthLens(AuthLens.AsUser(uid = "bob-uid"))
            val bobDoc = firestore.document("notes/bob-own")
            val bobWriteTask = bobDoc.set(mapOf("owner" to "bob", "title" to "Bob Note"))

            // Bob cannot read Alice's staged doc from cache.
            assertThrows(ExecutionException::class.java) {
                Tasks.await(aliceDoc.get(Source.CACHE))
            }

            // Bob reconnects: Alice's staged writes must abort locally without touching the bridge.
            Tasks.await(firestore.enableNetwork(), 5, TimeUnit.SECONDS)
            Tasks.await(bobWriteTask, 5, TimeUnit.SECONDS)

            val singleAbort = assertThrows(ExecutionException::class.java) {
                Tasks.await(aliceSingleTask, 5, TimeUnit.SECONDS)
            }
            assertEquals(
                FirebaseFirestoreException.Code.PERMISSION_DENIED,
                (singleAbort.cause as? FirebaseFirestoreException)?.code
            )

            val batchAbort = assertThrows(ExecutionException::class.java) {
                Tasks.await(aliceBatchTask, 5, TimeUnit.SECONDS)
            }
            assertEquals(
                FirebaseFirestoreException.Code.PERMISSION_DENIED,
                (batchAbort.cause as? FirebaseFirestoreException)?.code
            )

            // Only Bob's write reached the bridge; zero Alice writes or batchCommits were replayed.
            val writeOps = recordedOps.filter { it.method == "setDoc" || it.method == "batchCommit" }
            assertEquals(1, writeOps.size, "Expected only Bob's setDoc to flush, got: $writeOps")
            assertEquals("setDoc", writeOps[0].method)
            assertEquals("notes/bob-own", writeOps[0].params["path"])
            assertEquals("bob-uid", writeOps[0].actAs?.get("uid"))

            // Bob's RulesDenialListener must receive zero spurious denials.
            assertTrue(denials.isEmpty(), "Expected no spurious rules denials, got: $denials")

            // Bob's own doc is committed in Bob's cache without pending writes.
            val bobSnap = Tasks.await(bobDoc.get(Source.CACHE))
            assertTrue(bobSnap.exists())
            assertEquals("Bob Note", bobSnap.getString("title"))
            assertFalse(bobSnap.metadata.hasPendingWrites())

            // Switching back to Alice shows her aborted staged writes were not committed to cache.
            auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
            assertThrows(ExecutionException::class.java) {
                Tasks.await(aliceDoc.get(Source.CACHE))
            }
            Tasks.await(firestore.waitForPendingWrites(), 5, TimeUnit.SECONDS)
        } finally {
            denialReg.remove()
        }
    }
}
