package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.DocumentChangeCalculator
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.QueryDocumentSnapshot
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.firestore.SnapshotMetadata
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class FirestoreSnapshotsBatchTransactionsAggregateTest {
    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var client: PyricBridgeClient
    private lateinit var firestore: FirebaseFirestore
    private var activeSubId: String? = null

    @BeforeEach
    fun setUp() {
        sentOps.clear()
        activeSubId = null
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        val app = FirebaseApp.initializeApp(
            "slice1-unit-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("demo-slice1")
                .setApiKey("demo-key")
                .setApplicationId("demo-app-id")
                .build()
        )
        transport = InMemoryBridgeTransport()
        client = PyricBridgeClient(transport)
        firestore = FirebaseFirestore(client, app, "(default)")

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"] as? String) {
                "attach" -> transport.sendToClient(
                    """{"type":"attach-ack","protocol":1,"peerConnected":true}"""
                )
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    sentOps.add(op)
                    when (op["method"] as? String) {
                        "getDoc" -> {
                            val path = op["path"] as String
                            val reply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "id" to path.substringAfterLast('/'),
                                    "path" to path,
                                    "exists" to true,
                                    "data" to mapOf(
                                        "json" to """{"a.b":"literal","nested":{"x":7},"nullable":null,"tags":["k1"]}"""
                                    )
                                )
                            )
                            transport.sendToClient(JsonCodec.encodeToString(reply))
                        }
                        "getDocs" -> {
                            val reply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "docs" to listOf(
                                        docWire("items/a", """{"score":10}"""),
                                        docWire("items/b", """{"score":20}""")
                                    )
                                )
                            )
                            transport.sendToClient(JsonCodec.encodeToString(reply))
                        }
                        "count" -> {
                            val hasSource = op.containsKey("source") && !op.containsKey("target")
                            val reply = if (hasSource) {
                                mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("count" to 9))
                            } else {
                                mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to false,
                                    "error" to mapOf("code" to "invalid-argument", "message" to "Expected source")
                                )
                            }
                            transport.sendToClient(JsonCodec.encodeToString(reply))
                        }
                        "aggregate" -> {
                            @Suppress("UNCHECKED_CAST")
                            val spec = op["spec"] as? Map<String, Map<String, Any?>>
                            if (!op.containsKey("source") || spec == null) {
                                val err = mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to false,
                                    "error" to mapOf("code" to "invalid-argument", "message" to "Expected source + spec")
                                )
                                transport.sendToClient(JsonCodec.encodeToString(err))
                            } else {
                                val data = LinkedHashMap<String, Any?>()
                                val encodedData = LinkedHashMap<String, Any?>()
                                for ((alias, desc) in spec) {
                                    when (desc["kind"]) {
                                        "count" -> {
                                            data[alias] = 3
                                            encodedData[alias] = 3
                                        }
                                        "sum" -> {
                                            if (desc["field"] == "emptyField") {
                                                data[alias] = 0
                                                encodedData[alias] = 0
                                            } else if (desc["field"] == "nanField") {
                                                data[alias] = null
                                                encodedData[alias] = mapOf("__type" to "number", "value" to "NaN")
                                            } else {
                                                data[alias] = 42.5
                                                encodedData[alias] = 42.5
                                            }
                                        }
                                        "average" -> {
                                            if (desc["field"] == "emptyField") {
                                                data[alias] = null
                                                encodedData[alias] = null
                                            } else {
                                                data[alias] = 14.25
                                                encodedData[alias] = 14.25
                                            }
                                        }
                                    }
                                }
                                val reply = mapOf(
                                    "type" to "worker-res",
                                    "id" to id,
                                    "ok" to true,
                                    "value" to mapOf("data" to data, "encodedData" to encodedData)
                                )
                                transport.sendToClient(JsonCodec.encodeToString(reply))
                            }
                        }
                        else -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":null}"""
                        )
                    }
                }
                "worker-sub" -> {
                    val subId = frame["subId"] as String
                    activeSubId = subId
                    val initial = mapOf(
                        "type" to "worker-snap",
                        "subId" to subId,
                        "value" to mapOf(
                            "docs" to listOf(
                                docWire("items/a", """{"score":10}""", hasPendingWrites = false),
                                docWire("items/b", """{"score":20}""", hasPendingWrites = false)
                            ),
                            "hasPendingWrites" to false
                        )
                    )
                    transport.sendToClient(JsonCodec.encodeToString(initial))
                }
            }
        }
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun docWire(path: String, json: String, hasPendingWrites: Boolean = false): Map<String, Any?> =
        mapOf(
            "id" to path.substringAfterLast('/'),
            "path" to path,
            "exists" to true,
            "hasPendingWrites" to hasPendingWrites,
            "data" to mapOf("json" to json)
        )

    @Test
    fun `DocumentSnapshot defensive copy, contains, and FieldPath extraction preserve immutability`() {
        val snap = Tasks.await(firestore.document("items/d1").get())
        assertTrue(snap.contains("nested.x"))
        assertTrue(snap.contains(FieldPath.of("a.b")))
        assertTrue(snap.contains("nullable"))
        assertFalse(snap.contains("missing"))
        assertEquals("literal", snap.getString(FieldPath.of("a.b")))
        assertEquals(7L, snap.getLong(FieldPath.of("nested", "x")))
        assertNull(snap.get("nullable"))

        @Suppress("UNCHECKED_CAST")
        val mutableData = snap.getData() as MutableMap<String, Any?>
        mutableData["injected"] = "mutated"
        @Suppress("UNCHECKED_CAST")
        (mutableData["nested"] as MutableMap<String, Any?>)["x"] = 999
        assertFalse(snap.contains("injected"))
        assertEquals(7L, snap.getLong("nested.x"))
    }

    @Test
    fun `Query get populates ADDED documentChanges and permits both MetadataChanges modes`() {
        val snap = Tasks.await(firestore.collection("items").get())
        assertEquals(2, snap.documentChanges.size)
        assertEquals(listOf(DocumentChange.Type.ADDED, DocumentChange.Type.ADDED), snap.documentChanges.map { it.type })
        assertEquals(listOf(-1, -1), snap.documentChanges.map { it.oldIndex })
        assertEquals(listOf(0, 1), snap.documentChanges.map { it.newIndex })
        assertEquals(snap.documentChanges, snap.getDocumentChanges(MetadataChanges.INCLUDE))
    }

    @Test
    fun `Query listener computes sequential REMOVED ADDED MODIFIED indices and enforces MetadataChanges precondition`() {
        val received = CopyOnWriteArrayList<QuerySnapshot>()
        val latch1 = CountDownLatch(1)
        val latch2 = CountDownLatch(2)

        val reg = firestore.collection("items").addSnapshotListener(MetadataChanges.EXCLUDE) { qs, err ->
            if (err == null && qs != null) {
                received.add(qs)
                latch1.countDown()
                latch2.countDown()
            }
        }
        try {
            assertTrue(latch1.await(5, TimeUnit.SECONDS))
            val initial = received[0]
            assertThrows(IllegalArgumentException::class.java) {
                initial.getDocumentChanges(MetadataChanges.INCLUDE)
            }

            // Transition [a(10), b(20)] -> [b(20), c(25), a(30)]:
            // b is unchanged, c is added at index 2 (after stationary b while a moves), then a moves 0 -> 2.
            val nextFrame = mapOf(
                "type" to "worker-snap",
                "subId" to activeSubId,
                "value" to mapOf(
                    "docs" to listOf(
                        docWire("items/b", """{"score":20}"""),
                        docWire("items/c", """{"score":25}"""),
                        docWire("items/a", """{"score":30}""")
                    ),
                    "hasPendingWrites" to false
                )
            )
            transport.sendToClient(JsonCodec.encodeToString(nextFrame))
            assertTrue(latch2.await(5, TimeUnit.SECONDS))

            val updated = received[1]
            val adapter = mutableListOf("a", "b")
            for (change in updated.documentChanges) {
                when (change.type) {
                    DocumentChange.Type.REMOVED -> adapter.removeAt(change.oldIndex)
                    DocumentChange.Type.ADDED -> adapter.add(change.newIndex, change.document.id)
                    DocumentChange.Type.MODIFIED -> {
                        adapter.removeAt(change.oldIndex)
                        adapter.add(change.newIndex, change.document.id)
                    }
                }
            }
            assertEquals(listOf("b", "c", "a"), adapter)
            assertEquals(2, updated.documentChanges.size)
            assertEquals(DocumentChange.Type.ADDED, updated.documentChanges[0].type)
            assertEquals("c", updated.documentChanges[0].document.id)
            assertEquals(DocumentChange.Type.MODIFIED, updated.documentChanges[1].type)
            assertEquals("a", updated.documentChanges[1].document.id)
        } finally {
            reg.remove()
        }
    }

    @Test
    fun `DocumentChangeCalculator maintains adapter invariant across simultaneous removals additions and moves`() {
        fun doc(id: String, score: Int, pending: Boolean = false) = QueryDocumentSnapshot(
            id = id,
            reference = firestore.document("items/$id"),
            dataMap = mapOf("score" to score),
            metadata = SnapshotMetadata(hasPendingWrites = pending, isFromCache = false)
        )

        val prev = listOf(doc("a", 10), doc("b", 20), doc("c", 30), doc("d", 40))
        val curr = listOf(doc("c", 30), doc("e", 35), doc("b", 50), doc("f", 60))

        val changes = DocumentChangeCalculator.computeChanges(prev, curr, includeMetadataChanges = false)
        val adapter = prev.map { it.id }.toMutableList()
        for (ch in changes) {
            when (ch.type) {
                DocumentChange.Type.REMOVED -> {
                    assertEquals(ch.document.id, adapter.removeAt(ch.oldIndex))
                }
                DocumentChange.Type.ADDED -> {
                    adapter.add(ch.newIndex, ch.document.id)
                }
                DocumentChange.Type.MODIFIED -> {
                    assertEquals(ch.document.id, adapter.removeAt(ch.oldIndex))
                    adapter.add(ch.newIndex, ch.document.id)
                }
            }
        }
        assertEquals(curr.map { it.id }, adapter)
    }

    @Test
    fun `WriteBatch and Transaction encode FieldPath segment vectors and enforce read-before-write`() {
        val docRef = firestore.document("items/fp1")
        val batch = firestore.batch()
        batch.update(docRef, FieldPath.of("meta.v1", "count"), 5L, "plain.nested", "ok")
        Tasks.await(batch.commit())

        val batchOp = sentOps.single { it["method"] == "batchCommit" }
        @Suppress("UNCHECKED_CAST")
        val batchWrite = (batchOp["writes"] as List<Map<String, Any?>>).single()
        assertEquals("update", batchWrite["method"])
        assertFalse(batchWrite.containsKey("data"))
        assertEquals(
            listOf(
                mapOf("path" to listOf("meta.v1", "count"), "value" to 5),
                mapOf("path" to listOf("plain", "nested"), "value" to "ok")
            ),
            batchWrite["fields"]
        )

        val ex = assertThrows(ExecutionException::class.java) {
            Tasks.await(
                firestore.runTransaction { txn ->
                    txn.set(docRef, mapOf("k" to 1))
                    txn.get(docRef)
                }
            )
        }
        val fse = ex.cause as FirebaseFirestoreException
        assertEquals(FirebaseFirestoreException.Code.INVALID_ARGUMENT, fse.code)

        sentOps.clear()
        Tasks.await(
            firestore.runTransaction { txn ->
                txn.get(docRef)
                txn.get(firestore.document("items/fp2"))
                txn.update(docRef, FieldPath.of("a.b", "c"), 99L)
                null
            }
        )
        val txnGetOps = sentOps.filter { it["method"] == "getDoc" }
        assertEquals(2, txnGetOps.size)
        val pinnedTxnId = txnGetOps[0]["txnId"] as String
        assertTrue(pinnedTxnId.startsWith("kt-txn-"))
        assertEquals(pinnedTxnId, txnGetOps[1]["txnId"])
    }

    @Test
    fun `AggregateQuery sends source and spec wire contract, supports FieldPath equality, and decodes special numbers`() {
        assertEquals(AggregateField.sum("a.b"), AggregateField.sum(FieldPath.of("a", "b")))
        assertNotEquals(AggregateField.sum(FieldPath.of("a.b")), AggregateField.sum(FieldPath.of("a", "b")))
        assertEquals(AggregateField.average("x").hashCode(), AggregateField.average(FieldPath.of("x")).hashCode())

        val countSnap = Tasks.await(firestore.collection("items").count().get())
        assertEquals(9L, countSnap.count)
        assertThrows(IllegalArgumentException::class.java) {
            countSnap.get(AggregateField.sum("score"))
        }

        val dottedField = FieldPath.of("metrics.v1", "score")
        val aggSnap = Tasks.await(
            firestore.collection("items").aggregate(
                AggregateField.count(),
                AggregateField.sum(dottedField),
                AggregateField.average("emptyField"),
                AggregateField.sum("emptyField"),
                AggregateField.sum("nanField")
            ).get()
        )
        assertEquals(3L, aggSnap.count)
        assertEquals(42.5, aggSnap.get(AggregateField.sum(dottedField)))
        assertNull(aggSnap.get(AggregateField.average("emptyField")))
        assertEquals(0.0, aggSnap.get(AggregateField.sum("emptyField")))
        assertTrue(aggSnap.get(AggregateField.sum("nanField"))!!.isNaN())
        assertThrows(IllegalArgumentException::class.java) {
            aggSnap.get(AggregateField.average("unrequested"))
        }

        val aggOp = sentOps.single { it["method"] == "aggregate" }
        @Suppress("UNCHECKED_CAST")
        val spec = aggOp["spec"] as Map<String, Map<String, Any?>>
        val dottedAlias = AggregateField.sum(dottedField).alias
        assertEquals(listOf("metrics.v1", "score"), spec[dottedAlias]?.get("path"))
    }
}
