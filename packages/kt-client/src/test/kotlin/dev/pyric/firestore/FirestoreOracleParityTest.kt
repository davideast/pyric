package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.AggregateQuerySnapshot
import com.google.firebase.firestore.DocumentChangeCalculator
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.QueryDocumentSnapshot
import com.google.firebase.firestore.SnapshotMetadata
import com.google.firebase.firestore.data
import com.google.firebase.firestore.toObject
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

class FirestoreOracleParityTest {
    data class ScoreBean(
        @DocumentId var id: String = "",
        var smallCount: Int = 0,
        var totalScore: Long = 0L,
        var weight: Float = 0f,
        var ratio: Double = 0.0
    )

    class ReadOnlyFieldScoreBean(
        val smallCount: Int = 0,
        val totalScore: Long = 0L,
        val weight: Float = 0f,
        val ratio: Double = 0.0
    )

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var client: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        transport = InMemoryBridgeTransport()
        client = PyricBridgeClient(transport)
        app = FirebaseApp.initializeApp(
            "fs-oracle-parity-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("demo-oracle")
                .setApiKey("fake-key")
                .setApplicationId("1:1:android:oracle")
                .build()
        )
        firestore = FirebaseFirestore(client, app, "(default)")

        transport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            when (frame["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "getDoc" -> {
                            val docJson = """{"smallCount":7,"zero":0,"neg":-12,"big":5000000000,"ratio":1.75,"nested":{"rank":3,"scores":[1,2,5000000000,0.5]},"weight":2.5,"totalScore":42}"""
                            val reply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "id" to "d1",
                                    "path" to "items/d1",
                                    "exists" to true,
                                    "hasPendingWrites" to false,
                                    "data" to mapOf("json" to docJson)
                                )
                            )
                            transport.sendToClient(JsonCodec.encodeToString(reply))
                        }
                        "getDocs" -> {
                            val docJson = """{"smallCount":9,"nested":{"rank":4}}"""
                            val reply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "docs" to listOf(
                                        mapOf(
                                            "id" to "q1",
                                            "path" to "items/q1",
                                            "exists" to true,
                                            "hasPendingWrites" to false,
                                            "data" to mapOf("json" to docJson)
                                        )
                                    )
                                )
                            )
                            transport.sendToClient(JsonCodec.encodeToString(reply))
                        }
                        "aggregate" -> {
                            @Suppress("UNCHECKED_CAST")
                            val spec = op["spec"] as Map<String, Map<String, Any?>>
                            val data = LinkedHashMap<String, Any?>()
                            val encodedData = LinkedHashMap<String, Any?>()
                            for ((alias, desc) in spec) {
                                when (desc["kind"]) {
                                    "count" -> {
                                        data[alias] = 3
                                        encodedData[alias] = 3
                                    }
                                    "sum" -> when (desc["field"]) {
                                        "intScore" -> {
                                            data[alias] = 90
                                            encodedData[alias] = 90
                                        }
                                        "bigScore" -> {
                                            data[alias] = 6_000_000_000L
                                            encodedData[alias] = 6_000_000_000L
                                        }
                                        "emptyScore" -> {
                                            data[alias] = 0
                                            encodedData[alias] = 0
                                        }
                                        "floatScore" -> {
                                            data[alias] = 42.5
                                            encodedData[alias] = 42.5
                                        }
                                        "negZeroScore" -> {
                                            data[alias] = 0
                                            encodedData[alias] = mapOf("__type" to "number", "value" to "-0")
                                        }
                                        "nanScore" -> {
                                            data[alias] = null
                                            encodedData[alias] = mapOf("__type" to "number", "value" to "NaN")
                                        }
                                    }
                                    "average" -> when (desc["field"]) {
                                        "intScore" -> {
                                            data[alias] = 30
                                            encodedData[alias] = 30
                                        }
                                        "emptyScore" -> {
                                            data[alias] = null
                                            encodedData[alias] = null
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

    @Test
    fun `DocumentSnapshot and QueryDocumentSnapshot normalize integral fields to java_lang_Long and floats to java_lang_Double`() {
        val snap = Tasks.await(firestore.document("items/d1").get())
        val data = requireNotNull(snap.getData())
        val ktxData = requireNotNull(snap.data)
        assertEquals(data, ktxData)

        for (key in listOf("smallCount", "zero", "neg", "big", "totalScore")) {
            val fromMap = requireNotNull(data[key])
            val fromGet = requireNotNull(snap.get(key))
            assertEquals("java.lang.Long", fromMap::class.java.name, "getData()[$key] class")
            assertEquals("java.lang.Long", fromGet::class.java.name, "get($key) class")
        }
        assertEquals(7L, data["smallCount"])
        assertEquals(0L, snap.get("zero"))
        assertEquals(-12L, snap.get("neg"))
        assertEquals(5_000_000_000L, snap.get("big"))

        val ratioVal = requireNotNull(snap.get("ratio"))
        assertEquals("java.lang.Double", ratioVal::class.java.name)
        assertEquals(1.75, ratioVal as Double, 1e-9)

        @Suppress("UNCHECKED_CAST")
        val nested = data["nested"] as Map<String, Any?>
        assertEquals("java.lang.Long", requireNotNull(nested["rank"])::class.java.name)
        assertEquals(3L, nested["rank"])
        assertEquals("java.lang.Long", requireNotNull(snap.get("nested.rank"))::class.java.name)
        assertEquals("java.lang.Long", requireNotNull(snap.get(FieldPath.of("nested", "rank")))::class.java.name)

        @Suppress("UNCHECKED_CAST")
        val scores = nested["scores"] as List<Any?>
        assertEquals(
            listOf("java.lang.Long", "java.lang.Long", "java.lang.Long", "java.lang.Double"),
            scores.map { requireNotNull(it)::class.java.name }
        )
        assertEquals(listOf(1L, 2L, 5_000_000_000L, 0.5), scores)

        assertEquals(7L, snap.getLong("smallCount"))
        assertEquals(7.0, snap.getDouble("smallCount")!!, 1e-9)
        assertEquals(1L, snap.getLong("ratio"))

        val bean = requireNotNull(snap.toObject<ScoreBean>())
        assertEquals("d1", bean.id)
        assertEquals(7, bean.smallCount)
        assertEquals(42L, bean.totalScore)
        assertEquals(2.5f, bean.weight, 1e-6f)
        assertEquals(1.75, bean.ratio, 1e-9)

        val ctorBean = requireNotNull(snap.toObject(ReadOnlyFieldScoreBean::class.java))
        assertEquals(7, ctorBean.smallCount)
        assertEquals(42L, ctorBean.totalScore)

        val querySnap = Tasks.await(firestore.collection("items").get())
        val queryDoc: QueryDocumentSnapshot = querySnap.single()
        assertEquals("java.lang.Long", requireNotNull(queryDoc.getData()["smallCount"])::class.java.name)
        assertEquals("java.lang.Long", requireNotNull(queryDoc.data["smallCount"])::class.java.name)
        assertEquals(4L, queryDoc.get("nested.rank"))

        val ref = firestore.document("items/eq")
        val fromByteShortIntFloat = QueryDocumentSnapshot(
            id = "eq",
            reference = ref,
            dataMap = mapOf("b" to 2.toByte(), "s" to 3.toShort(), "i" to 10, "f" to 1.5f),
            metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
        )
        val fromLongDouble = QueryDocumentSnapshot(
            id = "eq",
            reference = ref,
            dataMap = mapOf("b" to 2L, "s" to 3L, "i" to 10L, "f" to 1.5),
            metadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
        )
        assertEquals(fromLongDouble, fromByteShortIntFloat)
        assertEquals(fromLongDouble.hashCode(), fromByteShortIntFloat.hashCode())
        assertEquals("java.lang.Long", requireNotNull(fromByteShortIntFloat.get("b"))::class.java.name)
        assertEquals("java.lang.Long", requireNotNull(fromByteShortIntFloat.get("s"))::class.java.name)
        assertEquals("java.lang.Double", requireNotNull(fromByteShortIntFloat.get("f"))::class.java.name)
        val diff = DocumentChangeCalculator.computeChanges(
            listOf(fromLongDouble),
            listOf(fromByteShortIntFloat),
            includeMetadataChanges = false
        )
        assertTrue(diff.isEmpty())
    }

    @Test
    fun `AggregateQuerySnapshot matches upstream 35_2_0 method table and returns Long for integer sums and Double for floating sums`() {
        val getOverloads = AggregateQuerySnapshot::class.java.methods
            .filter { it.name == "get" }
            .associate { m -> m.parameterTypes.map { it.name } to m.returnType.name }

        assertEquals(
            mapOf(
                listOf("com.google.firebase.firestore.AggregateField") to "java.lang.Object",
                listOf("com.google.firebase.firestore.AggregateField\$CountAggregateField") to "long",
                listOf("com.google.firebase.firestore.AggregateField\$AverageAggregateField") to "java.lang.Double"
            ),
            getOverloads
        )
        assertThrows(NoSuchMethodException::class.java) {
            AggregateQuerySnapshot::class.java.getMethod(
                "get",
                AggregateField.SumAggregateField::class.java
            )
        }

        val intSum = AggregateField.sum("intScore")
        val bigSum = AggregateField.sum("bigScore")
        val emptySum = AggregateField.sum("emptyScore")
        val floatSum = AggregateField.sum("floatScore")
        val negZeroSum = AggregateField.sum("negZeroScore")
        val nanSum = AggregateField.sum("nanScore")
        val intAvg = AggregateField.average("intScore")
        val emptyAvg = AggregateField.average("emptyScore")

        val snap = Tasks.await(
            firestore.collection("items").aggregate(
                AggregateField.count(),
                intSum,
                bigSum,
                emptySum,
                floatSum,
                negZeroSum,
                nanSum,
                intAvg,
                emptyAvg
            ).get()
        )

        assertEquals(3L, snap.count)
        assertEquals("java.lang.Long", requireNotNull(snap.get(AggregateField.count() as AggregateField))::class.java.name)

        val intSumVal = requireNotNull(snap.get(intSum))
        assertEquals("java.lang.Long", intSumVal::class.java.name)
        assertEquals(90L, intSumVal)
        assertEquals(90L, snap.getLong(intSum))
        assertEquals(90.0, snap.getDouble(intSum)!!, 1e-9)

        val bigSumVal = requireNotNull(snap.get(bigSum))
        assertEquals("java.lang.Long", bigSumVal::class.java.name)
        assertEquals(6_000_000_000L, bigSumVal)

        val emptySumVal = requireNotNull(snap.get(emptySum))
        assertEquals("java.lang.Long", emptySumVal::class.java.name)
        assertEquals(0L, emptySumVal)

        val floatSumVal = requireNotNull(snap.get(floatSum))
        assertEquals("java.lang.Double", floatSumVal::class.java.name)
        assertEquals(42.5, floatSumVal as Double, 1e-9)
        assertEquals(42L, snap.getLong(floatSum))

        val negZeroRaw = requireNotNull(snap.get(negZeroSum))
        assertEquals("java.lang.Double", negZeroRaw.javaClass.name)
        assertEquals(Long.MIN_VALUE, java.lang.Double.doubleToRawLongBits(negZeroRaw as Double))

        val nanRaw = requireNotNull(snap.get(nanSum))
        assertEquals("java.lang.Double", nanRaw.javaClass.name)
        assertTrue((nanRaw as Double).isNaN())

        val avgRaw: Any = requireNotNull(snap.get(intAvg))
        assertEquals("java.lang.Double", avgRaw.javaClass.name)
        assertEquals(30.0, avgRaw as Double, 1e-9)
        assertEquals("java.lang.Double", requireNotNull(snap.get(intAvg as AggregateField)).javaClass.name)
        assertNull(snap.get(emptyAvg))
        assertNull(snap.get(emptyAvg as AggregateField))
    }

    @Test
    fun `FirebaseFirestoreSettings defaults, LocalCacheSettings, and KTX DSL properties match Android 35_2_0`() {
        val defaultSettings = firestore.firestoreSettings
        assertEquals("firestore.googleapis.com", defaultSettings.host)
        assertTrue(defaultSettings.isSslEnabled)
        assertTrue(defaultSettings.isPersistenceEnabled)
        assertEquals(100L * 1024L * 1024L, defaultSettings.cacheSizeBytes)
        assertNull(defaultSettings.cacheSettings)

        assertThrows(IllegalStateException::class.java) {
            FirebaseFirestoreSettings.Builder().setSslEnabled(false).build()
        }

        val twentyMb = 20L * 1024L * 1024L
        val persistent = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(
                com.google.firebase.firestore.PersistentCacheSettings.newBuilder()
                    .setSizeBytes(twentyMb)
                    .build()
            )
            .build()
        assertEquals("firestore.googleapis.com", persistent.host)
        assertTrue(persistent.isSslEnabled)
        assertTrue(persistent.isPersistenceEnabled)
        assertTrue(persistent.cacheSettings is com.google.firebase.firestore.PersistentCacheSettings)
        assertEquals(twentyMb, persistent.cacheSizeBytes)
        assertEquals(persistent, FirebaseFirestoreSettings.Builder(persistent).build())

        val dslMemory = com.google.firebase.firestore.firestoreSettings {
            host = "127.0.0.1:8085"
            isSslEnabled = false
            setLocalCacheSettings(com.google.firebase.firestore.memoryCacheSettings {})
        }
        assertEquals("127.0.0.1:8085", dslMemory.host)
        assertEquals(false, dslMemory.isSslEnabled)
        assertEquals(false, dslMemory.isPersistenceEnabled)
        assertTrue(dslMemory.cacheSettings is com.google.firebase.firestore.MemoryCacheSettings)
        assertEquals(FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED, dslMemory.cacheSizeBytes)

        val lruBytes = 8L * 1024L * 1024L
        val dslLru = com.google.firebase.firestore.firestoreSettings {
            setLocalCacheSettings(
                com.google.firebase.firestore.memoryCacheSettings {
                    setGcSettings(
                        com.google.firebase.firestore.memoryLruGcSettings {
                            setSizeBytes(lruBytes)
                        }
                    )
                }
            )
        }
        assertEquals(false, dslLru.isPersistenceEnabled)
        assertEquals(lruBytes, dslLru.cacheSizeBytes)

        val ktxPersistent = com.google.firebase.firestore.firestoreSettings {
            setLocalCacheSettings(
                com.google.firebase.firestore.persistentCacheSettings {
                    setSizeBytes(16L * 1024L * 1024L)
                }
            )
        }
        assertTrue(ktxPersistent.isPersistenceEnabled)
        assertEquals(16L * 1024L * 1024L, ktxPersistent.cacheSizeBytes)

        assertThrows(IllegalStateException::class.java) {
            FirebaseFirestoreSettings.Builder()
                .setPersistenceEnabled(false)
                .setLocalCacheSettings(com.google.firebase.firestore.memoryCacheSettings {})
        }
        assertThrows(IllegalStateException::class.java) {
            FirebaseFirestoreSettings.Builder()
                .setLocalCacheSettings(com.google.firebase.firestore.memoryCacheSettings {})
                .setCacheSizeBytes(FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED)
        }

        firestore.firestoreSettings = dslMemory
        Tasks.await(firestore.disableNetwork())
        assertThrows(IllegalStateException::class.java) {
            firestore.firestoreSettings = com.google.firebase.firestore.firestoreSettings {
                host = "127.0.0.1:8086"
                isSslEnabled = false
            }
        }
    }

    @Test
    fun `collectionGroup empty-string parity and runTransaction contention exhaustion FAILED_PRECONDITION match Android 35_2_0`() {
        val emptyGroup = firestore.collectionGroup("")
        assertEquals("", emptyGroup.collectionId)
        assertTrue(emptyGroup.isCollectionGroup)
        assertThrows(IllegalArgumentException::class.java) {
            firestore.collectionGroup("invalid/slash")
        }

        val txTransport = InMemoryBridgeTransport()
        val txClient = PyricBridgeClient(txTransport)
        val txDb = FirebaseFirestore(txClient, app, "tx-exhaust-db")
        var commitCalls = 0
        var failRemainingCommits = 1

        txTransport.onServerReceive { rawJson ->
            val frame = JsonCodec.decodeMap(rawJson)
            when (frame["type"]) {
                "attach" -> txTransport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    if (op["method"] == "txnCommit") {
                        commitCalls += 1
                        if (failRemainingCommits > 0) {
                            failRemainingCommits -= 1
                            val errReply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf("code" to "aborted", "message" to "Contention on document")
                            )
                            txTransport.sendToClient(JsonCodec.encodeToString(errReply))
                        } else {
                            val okReply = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to null
                            )
                            txTransport.sendToClient(JsonCodec.encodeToString(okReply))
                        }
                    }
                }
            }
        }

        try {
            val retried = Tasks.await(
                txDb.runTransaction(
                    com.google.firebase.firestore.TransactionOptions.Builder().setMaxAttempts(3).build()
                ) { txn ->
                    txn.set(txDb.document("counters/c1"), mapOf("v" to 42))
                    42L
                }
            )
            assertEquals(42L, retried)
            assertEquals(2, commitCalls)

            commitCalls = 0
            failRemainingCommits = 5
            val execErr = assertThrows(java.util.concurrent.ExecutionException::class.java) {
                Tasks.await(
                    txDb.runTransaction(
                        com.google.firebase.firestore.TransactionOptions.Builder().setMaxAttempts(1).build()
                    ) { txn ->
                        txn.set(txDb.document("counters/c1"), mapOf("v" to 99))
                        99L
                    }
                )
            }
            val fsErr = execErr.cause as com.google.firebase.firestore.FirebaseFirestoreException
            assertEquals(1, commitCalls)
            assertEquals("FAILED_PRECONDITION", fsErr.code.name)
            assertEquals(9, fsErr.code.value())
            assertEquals(
                com.google.firebase.firestore.FirebaseFirestoreException.Code.FAILED_PRECONDITION,
                com.google.firebase.firestore.FirebaseFirestoreException.Code.fromValue(9)
            )
        } finally {
            runBlocking { txClient.disconnect() }
        }
    }
}
