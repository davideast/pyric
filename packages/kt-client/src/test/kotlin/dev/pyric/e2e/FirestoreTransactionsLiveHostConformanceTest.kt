package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.TransactionOptions
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class FirestoreTransactionsLiveHostConformanceTest {
    private val extraClients = CopyOnWriteArrayList<PyricBridgeClient>()
    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_FIRESTORE_BRIDGE_URL")
            ?: System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_FIRESTORE_BRIDGE_URL is unset; skipping live-host Kotlin Firestore conformance test"
        )
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        liveBridgeUrl = envUrl
        projectId = System.getenv("PYRIC_LIVE_FIRESTORE_PROJECT_ID") ?: "demo-kotlin-firestore"
        val app = FirebaseApp.initializeApp(
            FirebaseOptions.Builder()
                .setProjectId(projectId)
                .setApiKey("demo-firestore-api-key")
                .setApplicationId("1:424242424242:android:kotlinfirestore")
                .build()
        )
        val client = PyricBridgeClient(url = envUrl)
        bridgeClient = client
        auth = FirebaseAuth.getInstance(app, client)
        firestore = FirebaseFirestore.getInstance(app, client)

        val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        Tasks.await(auth.signInWithCustomToken(moderatorToken), 10, TimeUnit.SECONDS)
    }

    @AfterEach
    fun tearDown() {
        for (extra in extraClients) {
            runBlocking { extra.disconnect() }
        }
        extraClients.clear()
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        bridgeClient = null
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("rows #45-#48: proves WriteBatch set, merge, FieldPath update, delete, commit atomicity, and rules rollback")
    fun `proves WriteBatch set, merge, FieldPath update, delete, commit atomicity, and rules rollback`() {
        val prefix = "batch-${System.nanoTime()}"
        val itemsCol = firestore.collection("role_items/moderator/items")
        val doc1 = itemsCol.document("$prefix-1")
        val doc2 = itemsCol.document("$prefix-2")
        val doc3 = itemsCol.document("$prefix-3")

        Tasks.await(
            doc2.set(mapOf("keep" to "original", "count" to 5L, "meta.v1" to mapOf("flag" to "old"))),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(doc3.set(mapOf("obsolete" to true)), 10, TimeUnit.SECONDS)

        val batch = firestore.batch()
        batch.set(doc1, mapOf("name" to "Created", "count" to 1L))
        batch.set(doc2, mapOf("merged" to true), SetOptions.merge())
        batch.update(
            doc2,
            FieldPath.of("meta.v1", "flag"),
            "updated-dotted",
            "count",
            FieldValue.increment(10L)
        )
        batch.delete(doc3)
        Tasks.await(batch.commit(), 10, TimeUnit.SECONDS)

        assertThrows(IllegalStateException::class.java) { batch.set(doc1, mapOf("x" to 1)) }
        assertThrows(IllegalStateException::class.java) { batch.commit() }

        val snap1 = Tasks.await(doc1.get(), 10, TimeUnit.SECONDS)
        val snap2 = Tasks.await(doc2.get(), 10, TimeUnit.SECONDS)
        val snap3 = Tasks.await(doc3.get(), 10, TimeUnit.SECONDS)
        assertTrue(snap1.exists())
        assertEquals("Created", snap1.getString("name"))
        assertEquals("original", snap2.getString("keep"))
        assertEquals(true, snap2.getBoolean("merged"))
        assertEquals(15L, snap2.getLong("count"))
        assertEquals("updated-dotted", snap2.getString(FieldPath.of("meta.v1", "flag")))
        assertFalse(snap3.exists())

        val deniedBatch = firestore.batch()
        deniedBatch.update(doc1, mapOf("name" to "ShouldNotPersist"))
        deniedBatch.set(firestore.document("users/unauthorized-other-uid"), mapOf("intruder" to true))
        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(deniedBatch.commit(), 10, TimeUnit.SECONDS)
        }
        assertEquals("Created", Tasks.await(doc1.get(), 10, TimeUnit.SECONDS).getString("name"))
    }

    @Test
    @DisplayName("rows #49-#53: proves Transaction get/set/update/delete, pinned snapshot isolation, read-before-write, and live contention retry")
    fun `proves Transaction CRUD, snapshot isolation, read-before-write, and live contention retry`() {
        val prefix = "txn-${System.nanoTime()}"
        val itemsCol = firestore.collection("role_items/moderator/items")
        val accountA = itemsCol.document("$prefix-acct-a")
        val accountB = itemsCol.document("$prefix-acct-b")
        val tempDoc = itemsCol.document("$prefix-temp")

        Tasks.await(
            accountA.set(mapOf("balance" to 200L, "meta.v1" to mapOf("tag" to "init"))),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(accountB.set(mapOf("balance" to 50L)), 10, TimeUnit.SECONDS)
        Tasks.await(tempDoc.set(mapOf("ephemeral" to true)), 10, TimeUnit.SECONDS)

        assertFirestoreCode(FirebaseFirestoreException.Code.INVALID_ARGUMENT) {
            Tasks.await(
                firestore.runTransaction { txn ->
                    txn.set(accountB, mapOf("balance" to 60L), SetOptions.merge())
                    txn.get(accountA)
                },
                10,
                TimeUnit.SECONDS
            )
        }

        val postTransferA = Tasks.await(
            firestore.runTransaction { txn ->
                val snapA = txn.get(accountA)
                val snapB = txn.get(accountB)
                val nextA = (snapA.getLong("balance") ?: 0L) - 70L
                val nextB = (snapB.getLong("balance") ?: 0L) + 70L
                txn.update(accountA, FieldPath.of("meta.v1", "tag"), "debited", "balance", nextA)
                txn.set(accountB, mapOf("balance" to nextB, "settled" to true), SetOptions.merge())
                txn.delete(tempDoc)
                nextA
            },
            10,
            TimeUnit.SECONDS
        )
        assertEquals(130L, postTransferA)
        val verifyA = Tasks.await(accountA.get(), 10, TimeUnit.SECONDS)
        val verifyB = Tasks.await(accountB.get(), 10, TimeUnit.SECONDS)
        assertEquals(130L, verifyA.getLong("balance"))
        assertEquals("debited", verifyA.getString(FieldPath.of("meta.v1", "tag")))
        assertEquals(120L, verifyB.getLong("balance"))
        assertEquals(true, verifyB.getBoolean("settled"))
        assertFalse(Tasks.await(tempDoc.get(), 10, TimeUnit.SECONDS).exists())

        val peerApp = FirebaseApp.initializeApp(
            "peer-txn-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(projectId)
                .setApiKey("demo-firestore-api-key")
                .setApplicationId("1:424242424242:android:kotlinfirestore")
                .build()
        )
        val peerClient = PyricBridgeClient(url = liveBridgeUrl)
        extraClients.add(peerClient)
        val peerAuth = FirebaseAuth.getInstance(peerApp, peerClient)
        val peerFs = FirebaseFirestore.getInstance(peerApp, peerClient)
        val modToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        Tasks.await(peerAuth.signInWithCustomToken(modToken), 10, TimeUnit.SECONDS)

        val sharedCounter = itemsCol.document("$prefix-contended")
        Tasks.await(sharedCounter.set(mapOf("count" to 10L)), 10, TimeUnit.SECONDS)

        val attempts = AtomicInteger(0)
        val injectedConflict = AtomicBoolean(false)
        val finalCount = Tasks.await(
            firestore.runTransaction(
                TransactionOptions.Builder().setMaxAttempts(4).build()
            ) { txn ->
                val attemptNum = attempts.incrementAndGet()
                val current = txn.get(sharedCounter).getLong("count") ?: 0L
                if (attemptNum == 1 && injectedConflict.compareAndSet(false, true)) {
                    Tasks.await(
                        peerFs.document(sharedCounter.path).set(mapOf("count" to 100L)),
                        10,
                        TimeUnit.SECONDS
                    )
                }
                val next = current + 5L
                txn.update(sharedCounter, "count", next)
                next
            },
            10,
            TimeUnit.SECONDS
        )
        assertEquals(2, attempts.get())
        assertEquals(105L, finalCount)
        assertEquals(105L, Tasks.await(sharedCounter.get(), 10, TimeUnit.SECONDS).getLong("count"))

        val singleAttempts = AtomicInteger(0)
        assertFirestoreCode(FirebaseFirestoreException.Code.FAILED_PRECONDITION) {
            Tasks.await(
                firestore.runTransaction(
                    TransactionOptions.Builder().setMaxAttempts(1).build()
                ) { txn ->
                    singleAttempts.incrementAndGet()
                    val current = txn.get(sharedCounter).getLong("count") ?: 0L
                    Tasks.await(
                        peerFs.document(sharedCounter.path).set(mapOf("count" to current + 50L)),
                        10,
                        TimeUnit.SECONDS
                    )
                    txn.update(sharedCounter, "count", current + 1L)
                    current + 1L
                },
                10,
                TimeUnit.SECONDS
            )
        }
        assertEquals(1, singleAttempts.get())
        assertEquals(155L, Tasks.await(sharedCounter.get(), 10, TimeUnit.SECONDS).getLong("count"))
    }

    @Test
    @DisplayName("rows #64-#65: proves AggregateQuery count and multi-field sum/average over live host with rules enforcement")
    fun `proves AggregateQuery count and multi-field sum and average over live host`() {
        val prefix = "agg-${System.nanoTime()}"
        val itemsCol = firestore.collection("role_items/moderator/items")
        val rows = listOf(
            Triple("$prefix-1", 10L, 2.25),
            Triple("$prefix-2", 20L, 6.0),
            Triple("$prefix-3", 30L, 7.5)
        )
        for ((docId, price, bonus) in rows) {
            Tasks.await(
                itemsCol.document(docId).set(
                    mapOf(
                        "group" to prefix,
                        "price" to price,
                        "metrics.v1" to mapOf("bonus" to bonus)
                    )
                ),
                10,
                TimeUnit.SECONDS
            )
        }

        val matchingQuery = itemsCol.whereEqualTo("group", prefix)
        val countSnap = Tasks.await(matchingQuery.count().get(), 10, TimeUnit.SECONDS)
        assertEquals(3L, countSnap.count)
        assertEquals(3L, countSnap.get(AggregateField.count()))

        val filteredCount = Tasks.await(
            matchingQuery.whereGreaterThanOrEqualTo("price", 20L).count().get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(2L, filteredCount.count)

        val bonusPath = FieldPath.of("metrics.v1", "bonus")
        val multiSnap = Tasks.await(
            matchingQuery.aggregate(
                AggregateField.count(),
                AggregateField.sum("price"),
                AggregateField.average("price"),
                AggregateField.sum(bonusPath),
                AggregateField.average(bonusPath)
            ).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(3L, multiSnap.count)
        val priceSum = requireNotNull(multiSnap.get(AggregateField.sum("price")))
        assertEquals("java.lang.Long", priceSum.javaClass.name)
        assertEquals(60L, priceSum)
        assertEquals(60L, multiSnap.getLong(AggregateField.sum("price")))
        assertEquals(60.0, multiSnap.getDouble(AggregateField.sum("price"))!!, 1e-9)
        val priceAvg: Any = requireNotNull(multiSnap.get(AggregateField.average("price")))
        assertEquals("java.lang.Double", priceAvg.javaClass.name)
        assertEquals(20.0, priceAvg as Double, 1e-9)
        val bonusSum = requireNotNull(multiSnap.get(AggregateField.sum(bonusPath)))
        assertEquals("java.lang.Double", bonusSum.javaClass.name)
        assertEquals(15.75, bonusSum as Double, 1e-9)
        assertEquals(5.25, multiSnap.get(AggregateField.average(bonusPath))!!, 1e-9)
        assertThrows(IllegalArgumentException::class.java) {
            multiSnap.get(AggregateField.sum("unrequested"))
        }

        val emptyQuery = itemsCol.whereEqualTo("group", "$prefix-none")
        val emptyAgg = Tasks.await(
            emptyQuery.aggregate(
                AggregateField.count(),
                AggregateField.sum("price"),
                AggregateField.average("price")
            ).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(0L, emptyAgg.count)
        val emptySum = requireNotNull(emptyAgg.get(AggregateField.sum("price")))
        assertEquals("java.lang.Long", emptySum::class.java.name)
        assertEquals(0L, emptySum)
        assertNull(emptyAgg.get(AggregateField.average("price")))

        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(
                firestore.collection("rooms").count().get(),
                10,
                TimeUnit.SECONDS
            )
        }
        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(
                firestore.collection("rooms")
                    .aggregate(AggregateField.sum("price"))
                    .get(),
                10,
                TimeUnit.SECONDS
            )
        }
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
