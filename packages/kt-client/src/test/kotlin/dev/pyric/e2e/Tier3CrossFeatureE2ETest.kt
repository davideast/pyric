package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.snapshots
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

@DisplayName("Tier 3 Cross-Feature Interaction E2E Tests")
class Tier3CrossFeatureE2ETest {

    private lateinit var harness: E2ETestHarness
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        harness = E2ETestHarness()
        firestore = harness.createClient("tier3-app")
    }

    // ── 1. Transactions Combined with Sentinels ────────────────────────────

    @Test
    fun testTransactionWithIncrementSentinel() {
        val docRef = firestore.collection("cross-tx").document("wallet")
        Tasks.await(docRef.set(mapOf("balance" to 100L, "txCount" to 0L)))

        Tasks.await(
            firestore.runTransaction { txn ->
                val snap = txn.get(docRef)
                assertTrue(snap.exists())
                txn.update(
                    docRef,
                    mapOf(
                        "balance" to FieldValue.increment(25L),
                        "txCount" to FieldValue.increment(1L)
                    )
                )
                null
            }
        )

        val updated = Tasks.await(docRef.get())
        assertEquals(125L, updated.getLong("balance"))
        assertEquals(1L, updated.getLong("txCount"))
    }

    @Test
    fun testTransactionWithServerTimestampSentinel() {
        val docRef = firestore.collection("cross-tx").document("audit")
        Tasks.await(docRef.set(mapOf("status" to "pending")))

        Tasks.await(
            firestore.runTransaction { txn ->
                txn.update(
                    docRef,
                    mapOf(
                        "status" to "approved",
                        "approvedAt" to FieldValue.serverTimestamp()
                    )
                )
                null
            }
        )

        val updated = Tasks.await(docRef.get())
        assertEquals("approved", updated.getString("status"))
        assertNotNull(updated.getTimestamp("approvedAt"))
    }

    @Test
    fun testTransactionWithArrayUnionAndRemove() {
        val docRef = firestore.collection("cross-tx").document("groups")
        Tasks.await(docRef.set(mapOf("members" to listOf("alice", "bob"))))

        Tasks.await(
            firestore.runTransaction { txn ->
                txn.update(
                    docRef,
                    mapOf("members" to FieldValue.arrayUnion("charlie"))
                )
                null
            }
        )

        val updated1 = Tasks.await(docRef.get())
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("alice", "bob", "charlie"), updated1.get("members"))

        Tasks.await(
            firestore.runTransaction { txn ->
                txn.update(
                    docRef,
                    mapOf("members" to FieldValue.arrayRemove("bob"))
                )
                null
            }
        )

        val updated2 = Tasks.await(docRef.get())
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf("alice", "charlie"), updated2.get("members"))
    }

    // ── 2. Compound Queries with Real-Time Flow Listeners ──────────────────

    @Test
    fun testCompoundQueryWithRealtimeFlow() = runBlocking(Dispatchers.IO) {
        val col = firestore.collection("cross-flow-query")
        Tasks.await(col.document("1").set(mapOf("status" to "active", "priority" to 1)))

        val observedCounts = mutableListOf<Int>()
        val query = col.whereEqualTo("status", "active").whereGreaterThan("priority", 0)

        val job = launch {
            query.snapshots().take(4).collect { snap ->
                observedCounts.add(snap.size())
            }
        }

        delay(50)
        // Add a matching doc (count -> 2)
        Tasks.await(col.document("2").set(mapOf("status" to "active", "priority" to 5)))
        // Add a non-matching doc (count remains 2)
        Tasks.await(col.document("3").set(mapOf("status" to "active", "priority" to 0)))
        // Add another matching doc (count -> 3)
        Tasks.await(col.document("4").set(mapOf("status" to "active", "priority" to 2)))

        job.join()
        assertEquals(listOf(1, 2, 2, 3), observedCounts)
    }

    // ── 3. Batch Writes Triggering Multiple Snapshot Streams ───────────────

    @Test
    fun testBatchWriteTriggeringMultipleDocumentFlows() = runBlocking(Dispatchers.IO) {
        val doc1 = firestore.collection("cross-batch-docs").document("d1")
        val doc2 = firestore.collection("cross-batch-docs").document("d2")
        val doc3 = firestore.collection("cross-batch-docs").document("d3")

        Tasks.await(doc1.set(mapOf("v" to "init1")))
        Tasks.await(doc2.set(mapOf("v" to "init2")))
        Tasks.await(doc3.set(mapOf("v" to "init3")))

        val d1Vals = mutableListOf<String>()
        val d2Vals = mutableListOf<String>()
        val d3Vals = mutableListOf<String>()

        val job1 = launch { doc1.snapshots().take(2).collect { it.getString("v")?.let { v -> d1Vals.add(v) } } }
        val job2 = launch { doc2.snapshots().take(2).collect { it.getString("v")?.let { v -> d2Vals.add(v) } } }
        val job3 = launch { doc3.snapshots().take(2).collect { it.getString("v")?.let { v -> d3Vals.add(v) } } }

        delay(50)

        // Single atomic batch modifying all three docs
        val batch = firestore.batch()
        batch.update(doc1, mapOf("v" to "updated1"))
        batch.update(doc2, mapOf("v" to "updated2"))
        batch.update(doc3, mapOf("v" to "updated3"))
        Tasks.await(batch.commit())

        job1.join()
        job2.join()
        job3.join()

        assertEquals(listOf("init1", "updated1"), d1Vals)
        assertEquals(listOf("init2", "updated2"), d2Vals)
        assertEquals(listOf("init3", "updated3"), d3Vals)
    }

    @Test
    fun testBatchWriteTriggeringQueryFlowAdditionAndRemoval() = runBlocking(Dispatchers.IO) {
        val col = firestore.collection("cross-batch-query")
        val docIn = col.document("in")
        val docOut = col.document("out")

        Tasks.await(docIn.set(mapOf("active" to false)))
        Tasks.await(docOut.set(mapOf("active" to true)))

        val observedDocIds = mutableListOf<List<String>>()
        val job = launch {
            col.whereEqualTo("active", true).snapshots().take(2).collect { snap ->
                observedDocIds.add(snap.documents.map { it.id }.sorted())
            }
        }

        delay(50)

        // Atomic batch: docIn becomes active, docOut becomes inactive
        val batch = firestore.batch()
        batch.update(docIn, mapOf("active" to true))
        batch.update(docOut, mapOf("active" to false))
        Tasks.await(batch.commit())

        job.join()
        assertEquals(listOf(listOf("out"), listOf("in")), observedDocIds)
    }

    // ── 4. Query Cursors with Server Timestamps ────────────────────────────

    @Test
    fun testQueryCursorsWithServerTimestamp() {
        val col = firestore.collection("cross-ts-cursors")
        val t1 = Timestamp(1700000000L, 0)
        val t2 = Timestamp(1700000100L, 0)
        val t3 = Timestamp(1700000200L, 0)

        Tasks.await(col.document("doc1").set(mapOf("createdAt" to t1, "title" to "first")))
        Tasks.await(col.document("doc2").set(mapOf("createdAt" to t2, "title" to "second")))
        Tasks.await(col.document("doc3").set(mapOf("createdAt" to t3, "title" to "third")))

        val query = col.orderBy("createdAt", Query.Direction.ASCENDING).startAfter(t1)
        val snap = Tasks.await(query.get())

        assertEquals(2, snap.size())
        assertEquals("second", snap.documents[0].getString("title"))
        assertEquals("third", snap.documents[1].getString("title"))
    }

    // ── 5. Transaction Conflict Retry with Query Stream ────────────────────

    @Test
    fun testTransactionConflictRetryWithQueryStream() = runBlocking(Dispatchers.IO) {
        val docRef = firestore.collection("cross-conflict").document("counter")
        Tasks.await(docRef.set(mapOf("count" to 10L)))

        // Instruct harness to simulate 1 conflict before succeeding
        harness.conflictCountdown.set(1)

        val observedCounts = mutableListOf<Long>()
        val job = launch {
            firestore.collection("cross-conflict").whereGreaterThan("count", 0)
                .snapshots().take(2).collect { snap ->
                    snap.documents.firstOrNull()?.getLong("count")?.let { observedCounts.add(it) }
                }
        }

        delay(50)

        val result = Tasks.await(
            firestore.runTransaction { txn ->
                val snap = txn.get(docRef)
                val current = snap.getLong("count") ?: 0L
                val next = current + 1L
                txn.update(docRef, mapOf("count" to next))
                next
            }
        )

        job.join()

        assertEquals(11L, result)
        assertEquals(2, harness.transactionAttemptCount.get()) // 1 failed attempt + 1 retry succeeded
        assertEquals(listOf(10L, 11L), observedCounts)
    }

    // ── 6. Array Sentinels in Batch Impacting Array-Contains Query ─────────

    @Test
    fun testArraySentinelsInsideBatchImpactingArrayContainsQuery() = runBlocking(Dispatchers.IO) {
        val col = firestore.collection("cross-batch-array")
        val doc = col.document("article")
        Tasks.await(doc.set(mapOf("tags" to listOf("general"))))

        val observedMatches = mutableListOf<Int>()
        val job = launch {
            col.whereArrayContains("tags", "breaking").snapshots().take(2).collect { snap ->
                observedMatches.add(snap.size())
            }
        }

        delay(50)

        val batch = firestore.batch()
        batch.update(doc, mapOf("tags" to FieldValue.arrayUnion("breaking", "news")))
        Tasks.await(batch.commit())

        job.join()

        assertEquals(listOf(0, 1), observedMatches)
    }

    // ── 7. Delete Doc Triggers Document & Query Flow Simultaneously ────────

    @Test
    fun testDeleteDocTriggersDocumentAndQueryFlowSimultaneously() = runBlocking(Dispatchers.IO) {
        val col = firestore.collection("cross-delete-sync")
        val doc = col.document("target")
        Tasks.await(doc.set(mapOf("alive" to true)))

        val docExistsLog = mutableListOf<Boolean>()
        val queryCountLog = mutableListOf<Int>()

        val jobDoc = launch {
            doc.snapshots().take(2).collect { snap ->
                docExistsLog.add(snap.exists())
            }
        }
        val jobQuery = launch {
            col.whereEqualTo("alive", true).snapshots().take(2).collect { snap ->
                queryCountLog.add(snap.size())
            }
        }

        delay(50)

        Tasks.await(doc.delete())

        jobDoc.join()
        jobQuery.join()

        assertEquals(listOf(true, false), docExistsLog)
        assertEquals(listOf(1, 0), queryCountLog)
    }

    // ── 8. Subcollections in Transactions ──────────────────────────────────

    @Test
    fun testSubcollectionCRUDWithBatchesAndTransactions() {
        val parent = firestore.collection("projects").document("proj1")
        val child = parent.collection("tasks").document("task1")

        Tasks.await(parent.set(mapOf("name" to "Alpha", "taskCount" to 0L)))

        // Transaction updating parent and creating child in subcollection
        Tasks.await(
            firestore.runTransaction { txn ->
                txn.update(parent, mapOf("taskCount" to FieldValue.increment(1L)))
                txn.set(child, mapOf("desc" to "Initial Task", "done" to false))
                null
            }
        )

        val parentSnap = Tasks.await(parent.get())
        val childSnap = Tasks.await(child.get())

        assertEquals(1L, parentSnap.getLong("taskCount"))
        assertTrue(childSnap.exists())
        assertEquals("Initial Task", childSnap.getString("desc"))
        assertEquals(false, childSnap.getBoolean("done"))
    }
}
