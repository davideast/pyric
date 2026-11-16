package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Transaction
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.DocumentDataEnvelope
import dev.pyric.codecs.JsonCodec
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

class WireContractParityTest {
    private val sentFrames = CopyOnWriteArrayList<Map<String, Any?>>()
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        sentFrames.clear()
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        val app = FirebaseApp.initializeApp(
            "wire-parity-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-wire")
                .setApiKey("key")
                .setApplicationId("app-id")
                .build()
        )
        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)")

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            sentFrames.add(frame)
            when (frame["type"] as? String) {
                "attach" -> transport.sendToClient(
                    """{"type":"attach-ack","protocol":1,"peerConnected":true}"""
                )
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    val path = op["path"] as? String
                    if (method == "getDoc" && path == "items/existing") {
                        val wireJson = JsonCodec.encodeToString(
                            mapOf(
                                "type" to "pyric/map/1.0",
                                "fields" to mapOf(
                                    "type" to "order",
                                    "count" to 1,
                                    "createdAt" to mapOf(
                                        "type" to "firestore/timestamp/1.0",
                                        "seconds" to 1712000000,
                                        "nanoseconds" to 0
                                    )
                                )
                            )
                        )
                        val reply = mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf(
                                "id" to "existing",
                                "path" to "items/existing",
                                "exists" to true,
                                "data" to mapOf(
                                    "valueEncoding" to ValueCodec.DOC_VALUE_ENCODING_V1,
                                    "json" to wireJson
                                )
                            )
                        )
                        transport.sendToClient(JsonCodec.encodeToString(reply))
                    } else if (method == "getDoc" && path == "items/missing") {
                        val reply = mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf(
                                "id" to "missing",
                                "path" to "items/missing",
                                "exists" to false,
                                "data" to null
                            )
                        )
                        transport.sendToClient(JsonCodec.encodeToString(reply))
                    } else {
                        transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":null}"""
                        )
                    }
                }
            }
        }
    }

    @AfterEach
    fun tearDown() {
        runBlocking { bridgeClient.disconnect() }
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun opsNamed(method: String): List<Map<String, Any?>> {
        return sentFrames
            .filter { it["type"] == "worker-op" }
            .mapNotNull {
                @Suppress("UNCHECKED_CAST")
                it["op"] as? Map<String, Any?>
            }
            .filter { it["method"] == method }
    }

    @Test
    fun `attach frame advertises pyric firestore value encoding capability`() {
        val frame = BridgeProtocol.createAttachFrame()
        assertEquals(BridgeProtocol.TYPE_ATTACH, frame["type"])
        assertEquals(BridgeProtocol.PROTOCOL_VERSION, frame["protocol"])
        assertEquals(listOf(ValueCodec.DOC_VALUE_ENCODING_V1), frame["capabilities"])
    }

    @Test
    fun `DocumentDataEnvelope unwraps pyric map wrappers and decodes non-finite number markers`() {
        val encoded = JsonCodec.encodeToString(
            mapOf(
                "type" to "pyric/map/1.0",
                "fields" to mapOf(
                    "type" to "order",
                    "nav" to mapOf(
                        "type" to "pyric/map/1.0",
                        "fields" to mapOf("id" to "home", "path" to "/home")
                    ),
                    "fakeTs" to mapOf(
                        "type" to "pyric/map/1.0",
                        "fields" to mapOf(
                            "type" to "firestore/timestamp/1.0",
                            "seconds" to 1,
                            "nanoseconds" to 2
                        )
                    ),
                    "realTs" to mapOf(
                        "type" to "firestore/timestamp/1.0",
                        "seconds" to 1712000000,
                        "nanoseconds" to 5
                    ),
                    "nanVal" to mapOf("__type" to "number", "value" to "NaN"),
                    "infVal" to mapOf("__type" to "number", "value" to "Infinity"),
                    "negInfVal" to mapOf("__type" to "number", "value" to "-Infinity"),
                    "negZeroVal" to mapOf("__type" to "number", "value" to "-0")
                )
            )
        )

        val decoded = DocumentDataEnvelope.unpack(
            mapOf("valueEncoding" to ValueCodec.DOC_VALUE_ENCODING_V1, "json" to encoded)
        )
        assertEquals("order", decoded["type"])
        assertEquals(mapOf("id" to "home", "path" to "/home"), decoded["nav"])
        assertEquals(
            mapOf("type" to "firestore/timestamp/1.0", "seconds" to 1, "nanoseconds" to 2),
            decoded["fakeTs"]
        )
        assertEquals(Timestamp(1712000000L, 5), decoded["realTs"])
        assertTrue((decoded["nanVal"] as Double).isNaN())
        assertEquals(Double.POSITIVE_INFINITY, decoded["infVal"])
        assertEquals(Double.NEGATIVE_INFINITY, decoded["negInfVal"])
        assertEquals((-0.0).toRawBits(), (decoded["negZeroVal"] as Double).toRawBits())

        val legacy = DocumentDataEnvelope.unpack(
            mapOf(
                "json" to JsonCodec.encodeToString(
                    mapOf("type" to "pyric/map/1.0", "fields" to mapOf("a" to 1))
                )
            )
        )
        assertEquals("pyric/map/1.0", legacy["type"])
        assertEquals(mapOf("a" to 1), legacy["fields"])
    }

    @Test
    fun `DocumentReference set emits nested options for merge and mergeFields and omits on overwrite`() {
        val doc = firestore.document("items/doc1")
        Tasks.await(doc.set(mapOf("a" to 1)))
        Tasks.await(doc.set(mapOf("b" to 2), SetOptions.merge()))
        Tasks.await(doc.set(mapOf("c" to 3), SetOptions.mergeFields("c", "nested.d")))
        Tasks.await(doc.set(mapOf("e" to 4), SetOptions.mergeFieldPaths(listOf(FieldPath.of("meta", "tag")))))

        val setOps = opsNamed("setDoc")
        assertEquals(4, setOps.size)

        assertFalse(setOps[0].containsKey("merge"))
        assertFalse(setOps[0].containsKey("options"))

        assertFalse(setOps[1].containsKey("merge"))
        assertEquals(mapOf("merge" to true), setOps[1]["options"])

        assertFalse(setOps[2].containsKey("merge"))
        assertEquals(mapOf("mergeFields" to listOf("c", "nested.d")), setOps[2]["options"])

        assertFalse(setOps[3].containsKey("merge"))
        assertEquals(mapOf("mergeFields" to listOf("meta.tag")), setOps[3]["options"])
    }

    @Test
    fun `WriteBatch emits method and nested options instead of op and top-level merge`() {
        val batch = firestore.batch()
        batch.set(firestore.document("items/a"), mapOf("v" to 1))
        batch.set(firestore.document("items/b"), mapOf("v" to 2), SetOptions.merge())
        batch.set(firestore.document("items/c"), mapOf("v" to 3), SetOptions.mergeFields("v"))
        batch.update(firestore.document("items/d"), mapOf("v" to 4))
        batch.delete(firestore.document("items/e"))
        Tasks.await(batch.commit())

        val op = opsNamed("batchCommit").single()
        @Suppress("UNCHECKED_CAST")
        val writes = op["writes"] as List<Map<String, Any?>>
        assertEquals(5, writes.size)

        for (w in writes) {
            assertFalse(w.containsKey("op"))
            assertFalse(w.containsKey("merge"))
        }

        assertEquals("set", writes[0]["method"])
        assertFalse(writes[0].containsKey("options"))

        assertEquals("set", writes[1]["method"])
        assertEquals(mapOf("merge" to true), writes[1]["options"])

        assertEquals("set", writes[2]["method"])
        assertEquals(mapOf("mergeFields" to listOf("v")), writes[2]["options"])

        assertEquals("update", writes[3]["method"])
        assertEquals("delete", writes[4]["method"])
    }

    @Test
    fun `Transaction emits canonical reads for existing and missing docs and canonical write descriptors`() {
        val result = Tasks.await(
            firestore.runTransaction(Transaction.Function<String> { txn ->
                val existing = txn.get(firestore.document("items/existing"))
                val missing = txn.get(firestore.document("items/missing"))
                assertTrue(existing.exists())
                assertEquals("order", existing.getString("type"))
                assertFalse(missing.exists())

                txn.set(firestore.document("items/existing"), mapOf("count" to 2), SetOptions.merge())
                txn.set(firestore.document("items/missing"), mapOf("label" to "new"), SetOptions.mergeFields("label"))
                txn.update(firestore.document("items/u"), mapOf("count" to 3))
                txn.delete(firestore.document("items/d"))
                "ok"
            })
        )
        assertEquals("ok", result)

        val op = opsNamed("txnCommit").single()
        @Suppress("UNCHECKED_CAST")
        val reads = op["reads"] as List<Map<String, Any?>>
        assertEquals(2, reads.size)

        assertEquals("items/existing", reads[0]["path"])
        @Suppress("UNCHECKED_CAST")
        val existingReadData = reads[0]["data"] as Map<String, Any?>
        assertEquals(ValueCodec.DOC_VALUE_ENCODING_V1, existingReadData["valueEncoding"])
        assertTrue((existingReadData["json"] as String).contains("pyric/map/1.0"))

        assertEquals("items/missing", reads[1]["path"])
        assertTrue(reads[1].containsKey("data"))
        assertNull(reads[1]["data"])

        @Suppress("UNCHECKED_CAST")
        val writes = op["writes"] as List<Map<String, Any?>>
        assertEquals(4, writes.size)
        for (w in writes) {
            assertFalse(w.containsKey("op"))
            assertFalse(w.containsKey("merge"))
        }
        assertEquals("set", writes[0]["method"])
        assertEquals(mapOf("merge" to true), writes[0]["options"])
        assertEquals("set", writes[1]["method"])
        assertEquals(mapOf("mergeFields" to listOf("label")), writes[1]["options"])
        assertEquals("update", writes[2]["method"])
        assertEquals("delete", writes[3]["method"])
    }
}
