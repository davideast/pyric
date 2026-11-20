package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SnapshotMetadata
import com.google.firebase.firestore.Source
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import dev.pyric.codecs.ValueCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.ExecutionException

class FirestoreQueriesAndCursorsParityTest {
    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        harness = ConformanceMockHarness()
    }

    @AfterEach
    fun tearDown() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Suppress("UNCHECKED_CAST")
    private fun constraints(q: Query): List<Map<String, Any?>> =
        (q.toTargetDescriptor()["constraints"] as? List<Map<String, Any?>>) ?: emptyList()

    @Test
    fun `FieldPath with literal dots emits fieldSegments on where and orderBy`() {
        val dotted = FieldPath.of("meta.tier", "score.value")
        val q = harness.firestore.collection("items")
            .whereGreaterThan(dotted, 10)
            .orderBy(dotted, Query.Direction.DESCENDING)

        val c = constraints(q)
        assertEquals(2, c.size)
        assertEquals("where", c[0]["kind"])
        assertEquals("meta.tier.score.value", c[0]["field"])
        assertEquals(listOf("meta.tier", "score.value"), c[0]["fieldSegments"])
        assertEquals(ValueCodec.DOC_VALUE_ENCODING_V1, c[0]["valueEncoding"])

        assertEquals("orderBy", c[1]["kind"])
        assertEquals("meta.tier.score.value", c[1]["field"])
        assertEquals(listOf("meta.tier", "score.value"), c[1]["fieldSegments"])
        assertEquals("desc", c[1]["direction"])

        // Reserved marker keys in map query operands are wrapped with pyric/map/1.0
        val mapQuery = harness.firestore.collection("items")
            .whereEqualTo("meta", mapOf("type" to "order", "id" to "x", "path" to "/x"))
        val mapConstraint = constraints(mapQuery).single()
        assertEquals(
            mapOf(
                "type" to "pyric/map/1.0",
                "fields" to mapOf("type" to "order", "id" to "x", "path" to "/x")
            ),
            mapConstraint["value"]
        )
    }

    @Test
    fun `Snapshot cursor normalizes unordered inequality fields in FieldPath segment order and inherits direction`() {
        val docRef = harness.firestore.document("items/item-7")
        val snap = DocumentSnapshot(
            id = "item-7",
            reference = docRef,
            exists = true,
            rawData = mapOf(
                "rank" to 5L,
                "alpha" to 10L,
                "zeta" to 20L
            ),
            metadata = SnapshotMetadata(false, false)
        )

        // Add snapshot cursor first, then append composite inequality filter afterwards:
        // compileTarget must recompute normalized orders across all filters.
        val q = harness.firestore.collection("items")
            .orderBy("rank", Query.Direction.DESCENDING)
            .startAfter(snap)
            .where(
                Filter.and(
                    Filter.greaterThan("zeta", 1L),
                    Filter.notEqualTo("alpha", 0L)
                )
            )

        val cursor = constraints(q).single { it["kind"] == "startAfter" }
        assertEquals(true, cursor["fromSnapshot"])
        assertEquals(ValueCodec.DOC_VALUE_ENCODING_V1, cursor["valueEncoding"])
        assertEquals(
            listOf(
                5L,
                10L,
                20L,
                mapOf("__type" to "reference", "path" to "items/item-7")
            ),
            cursor["values"]
        )
    }

    @Test
    fun `Snapshot cursor rejects missing ordered field while allowing explicit null value`() {
        val docRef = harness.firestore.document("items/item-null")
        val withNull = DocumentSnapshot(
            id = "item-null",
            reference = docRef,
            exists = true,
            rawData = mapOf("rank" to null),
            metadata = SnapshotMetadata(false, false)
        )
        val qNull = harness.firestore.collection("items").orderBy("rank").endAt(withNull)
        val nullCursor = constraints(qNull).single { it["kind"] == "endAt" }
        assertEquals(
            listOf(null, mapOf("__type" to "reference", "path" to "items/item-null")),
            nullCursor["values"]
        )

        val missingFieldSnap = DocumentSnapshot(
            id = "item-missing",
            reference = harness.firestore.document("items/item-missing"),
            exists = true,
            rawData = mapOf("other" to 1),
            metadata = SnapshotMetadata(false, false)
        )
        val qMissing = harness.firestore.collection("items").orderBy("rank").startAt(missingFieldSnap)
        assertThrows(IllegalArgumentException::class.java) {
            qMissing.toTargetDescriptor()
        }
    }

    @Test
    fun `Explicit value cursors validate arity, sentinels, and documentId paths`() {
        val base = harness.firestore.collection("items").orderBy("score")
        assertThrows(IllegalArgumentException::class.java) {
            base.startAt(10, 20).toTargetDescriptor()
        }
        assertThrows(IllegalArgumentException::class.java) {
            base.startAt(FieldValue.serverTimestamp()).toTargetDescriptor()
        }

        val docRef = harness.firestore.document("items/doc-2")
        val byId = harness.firestore.collection("items")
            .orderBy(FieldPath.documentId())
            .startAt(docRef)
        val idCursor = constraints(byId).single { it["kind"] == "startAt" }
        assertEquals(listOf("items/doc-2"), idCursor["values"])

        val cgById = harness.firestore.collectionGroup("items")
            .orderBy(FieldPath.documentId())
            .startAfter("bare-id")
        assertThrows(IllegalArgumentException::class.java) {
            cgById.toTargetDescriptor()
        }
    }

    @Test
    fun `Query get honors Source CACHE, SERVER, and persistence disabled precondition`() {
        val app = FirebaseApp.initializeApp(
            "query-source-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-query-source")
                .setApiKey("key")
                .setApplicationId("app-id")
                .build()
        )
        val transport = InMemoryBridgeTransport()
        var serverCalls = 0
        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    serverCalls++
                    val id = frame["id"] as String
                    val reply = mapOf(
                        "type" to "worker-res",
                        "id" to id,
                        "ok" to true,
                        "value" to mapOf(
                            "docs" to listOf(
                                mapOf(
                                    "id" to "i1",
                                    "path" to "items/i1",
                                    "exists" to true,
                                    "data" to mapOf("title" to "v$serverCalls")
                                )
                            )
                        )
                    )
                    transport.sendToClient(JsonCodec.encodeToString(reply))
                }
            }
        }
        val bridge = PyricBridgeClient(transport)
        val db = FirebaseFirestore(bridge, app, "(default)")
        val query = db.collection("items").whereEqualTo("active", true)

        // Cold Source.CACHE returns empty snapshot with isFromCache = true and zero RPCs.
        val coldCache = Tasks.await(query.get(Source.CACHE))
        assertTrue(coldCache.isEmpty)
        assertTrue(coldCache.metadata.isFromCache)
        assertEquals(0, serverCalls)

        // Source.DEFAULT hits server and warms cache.
        val firstServer = Tasks.await(query.get(Source.DEFAULT))
        assertEquals(1, firstServer.size())
        assertEquals("v1", firstServer.documents[0].getString("title"))
        assertFalse(firstServer.metadata.isFromCache)
        assertEquals(1, serverCalls)

        // Warm Source.CACHE returns cached v1 without hitting server.
        val warmCache = Tasks.await(query.get(Source.CACHE))
        assertEquals(1, warmCache.size())
        assertEquals("v1", warmCache.documents[0].getString("title"))
        assertTrue(warmCache.metadata.isFromCache)
        assertEquals(1, serverCalls)

        // Source.SERVER bypasses cache and fetches v2.
        val freshServer = Tasks.await(query.get(Source.SERVER))
        assertEquals("v2", freshServer.documents[0].getString("title"))
        assertFalse(freshServer.metadata.isFromCache)
        assertEquals(2, serverCalls)

        // Persistence disabled rejects Source.CACHE with UNAVAILABLE.
        val noPersistDb = FirebaseFirestore(bridge, app, "no-persist")
        noPersistDb.firestoreSettings = FirebaseFirestoreSettings.Builder()
            .setPersistenceEnabled(false)
            .build()
        val ex = assertThrows(ExecutionException::class.java) {
            Tasks.await(noPersistDb.collection("items").get(Source.CACHE))
        }
        val fse = ex.cause as FirebaseFirestoreException
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, fse.code)
    }
}
