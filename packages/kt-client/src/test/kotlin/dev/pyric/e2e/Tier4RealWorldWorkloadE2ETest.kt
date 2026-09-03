package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
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

@DisplayName("Tier 4 Real-World Workload E2E Tests")
class Tier4RealWorldWorkloadE2ETest {

    private lateinit var harness: E2ETestHarness
    private lateinit var clientA: FirebaseFirestore
    private lateinit var clientB: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        harness = E2ETestHarness()
        clientA = harness.createClient("client-a")
        clientB = harness.createClient("client-b")
    }

    // ── 1. Full Todo Application Lifecycle with Reactive Sync ─────────────

    @Test
    fun testTodoAppFullLifecycleWithReactiveSync() = runBlocking(Dispatchers.IO) {
        val todosCol = clientA.collection("todos")
        val observedActiveCounts = mutableListOf<Int>()

        // Reactive listener for active (incomplete) todos
        val activeQuery = todosCol.whereEqualTo("completed", false)
        val job = launch {
            activeQuery.snapshots().take(4).collect { snap ->
                observedActiveCounts.add(snap.size())
            }
        }

        delay(50)

        // 1. User creates 3 todos
        val task1 = todosCol.document("task-1")
        val task2 = todosCol.document("task-2")
        val task3 = todosCol.document("task-3")

        Tasks.await(task1.set(mapOf("title" to "Buy milk", "completed" to false, "createdAt" to FieldValue.serverTimestamp())))
        Tasks.await(task2.set(mapOf("title" to "Walk dog", "completed" to false, "createdAt" to FieldValue.serverTimestamp())))
        Tasks.await(task3.set(mapOf("title" to "Review PR", "completed" to false, "createdAt" to FieldValue.serverTimestamp())))

        // Verify initial counts in query: 3 active todos
        val activeSnap = Tasks.await(activeQuery.get())
        assertEquals(3, activeSnap.size())

        // 2. User marks "Buy milk" as completed
        Tasks.await(task1.update(mapOf("completed" to true, "completedAt" to FieldValue.serverTimestamp())))

        // Verify filtered views
        val completedSnap = Tasks.await(todosCol.whereEqualTo("completed", true).get())
        assertEquals(1, completedSnap.size())
        assertEquals("task-1", completedSnap.documents[0].id)
        assertNotNull(completedSnap.documents[0].getTimestamp("completedAt"))

        val activeAfterComplete = Tasks.await(activeQuery.get())
        assertEquals(2, activeAfterComplete.size())

        // 3. User deletes "Walk dog"
        Tasks.await(task2.delete())

        val finalActiveSnap = Tasks.await(activeQuery.get())
        assertEquals(1, finalActiveSnap.size())
        assertEquals("Review PR", finalActiveSnap.documents[0].getString("title"))

        job.join()
        // Emissions observed: initial(0) -> add1(1) -> add2(2) -> add3(3)
        assertEquals(listOf(0, 1, 2, 3), observedActiveCounts)
    }

    // ── 2. Multi-Client Concurrent Mutations ───────────────────────────────

    @Test
    fun testMultiClientConcurrentMutations() = runBlocking(Dispatchers.IO) {
        val docRefA = clientA.collection("polls").document("election")
        val docRefB = clientB.collection("polls").document("election")

        Tasks.await(docRefA.set(mapOf("votes" to 0L, "voters" to emptyList<String>())))

        // Client B monitors poll in real time
        val observedVotes = mutableListOf<Long>()
        val job = launch {
            docRefB.snapshots().take(3).collect { snap ->
                snap.getLong("votes")?.let { observedVotes.add(it) }
            }
        }

        delay(50)

        // Client A and Client B cast votes concurrently using increment and arrayUnion
        val taskA = clientA.runTransaction { txn ->
            txn.update(
                docRefA,
                mapOf(
                    "votes" to FieldValue.increment(1L),
                    "voters" to FieldValue.arrayUnion("voterA")
                )
            )
            null
        }

        val taskB = clientB.runTransaction { txn ->
            txn.update(
                docRefB,
                mapOf(
                    "votes" to FieldValue.increment(1L),
                    "voters" to FieldValue.arrayUnion("voterB")
                )
            )
            null
        }

        Tasks.await(taskA)
        Tasks.await(taskB)
        job.join()

        // Both clients read final state
        val finalA = Tasks.await(docRefA.get())
        val finalB = Tasks.await(docRefB.get())

        assertEquals(2L, finalA.getLong("votes"))
        assertEquals(2L, finalB.getLong("votes"))

        @Suppress("UNCHECKED_CAST")
        val votersA = (finalA.get("voters") as List<String>).sorted()
        @Suppress("UNCHECKED_CAST")
        val votersB = (finalB.get("voters") as List<String>).sorted()

        assertEquals(listOf("voterA", "voterB"), votersA)
        assertEquals(listOf("voterA", "voterB"), votersB)
        assertEquals(listOf(0L, 1L, 2L), observedVotes)
    }

    // ── 3. Transaction Conflict Resolution Under Concurrency ──────────────

    @Test
    fun testTransactionConflictResolutionUnderConcurrency() {
        val inventoryRefA = clientA.collection("warehouse").document("item-100")
        val inventoryRefB = clientB.collection("warehouse").document("item-100")

        Tasks.await(inventoryRefA.set(mapOf("stock" to 10L)))

        // First client executes a debit of 4
        Tasks.await(
            clientA.runTransaction { txn ->
                val snap = txn.get(inventoryRefA)
                val current = snap.getLong("stock") ?: 0L
                val next = current - 4L
                txn.update(inventoryRefA, mapOf("stock" to next))
                next
            }
        )

        // Verify intermediate stock is 6
        assertEquals(6L, Tasks.await(inventoryRefA.get()).getLong("stock"))

        // Simulate conflict for Client B's first attempt
        harness.conflictCountdown.set(1)

        // Client B executes debit of 3 with automatic retry
        val finalDebit = Tasks.await(
            clientB.runTransaction { txn ->
                val snap = txn.get(inventoryRefB)
                val current = snap.getLong("stock") ?: 0L
                val next = current - 3L
                txn.update(inventoryRefB, mapOf("stock" to next))
                next
            }
        )

        assertEquals(3L, finalDebit)
        assertEquals(3L, Tasks.await(inventoryRefA.get()).getLong("stock"))
        assertEquals(3L, Tasks.await(inventoryRefB.get()).getLong("stock"))
    }

    // ── 4. Rapid Batch Operations Workload ──────────────────────────────────

    @Test
    fun testRapidBatchOperationsWorkload() {
        val col = clientA.collection("workload-items")
        val totalItems = 50
        val chunkSize = 10

        // Phase 1: Rapid inserts in chunks of 10
        for (chunk in 0 until (totalItems / chunkSize)) {
            val batch = clientA.batch()
            for (i in 1..chunkSize) {
                val id = "item-${chunk * chunkSize + i}"
                batch.set(col.document(id), mapOf("status" to "raw", "seq" to (chunk * chunkSize + i)))
            }
            Tasks.await(batch.commit())
        }

        // Verify count
        val rawSnap = Tasks.await(col.whereEqualTo("status", "raw").get())
        assertEquals(totalItems, rawSnap.size())

        // Phase 2: Rapid status updates in chunks of 10
        for (chunk in 0 until (totalItems / chunkSize)) {
            val batch = clientA.batch()
            for (i in 1..chunkSize) {
                val id = "item-${chunk * chunkSize + i}"
                batch.update(col.document(id), mapOf("status" to "processed"))
            }
            Tasks.await(batch.commit())
        }

        val processedSnap = Tasks.await(col.whereEqualTo("status", "processed").get())
        assertEquals(totalItems, processedSnap.size())

        // Phase 3: Rapid batch deletes
        for (chunk in 0 until (totalItems / chunkSize)) {
            val batch = clientA.batch()
            for (i in 1..chunkSize) {
                val id = "item-${chunk * chunkSize + i}"
                batch.delete(col.document(id))
            }
            Tasks.await(batch.commit())
        }

        val emptySnap = Tasks.await(col.get())
        assertEquals(0, emptySnap.size())
    }

    // ── 5. Collaborative Audit Log Workload ─────────────────────────────────

    @Test
    fun testCollaborativeAuditLogWorkload() = runBlocking(Dispatchers.IO) {
        val orgRef = clientA.collection("organizations").document("org-1")
        val auditCol = orgRef.collection("auditLogs")

        Tasks.await(orgRef.set(mapOf("name" to "Acme Corp", "eventCount" to 0L)))

        val observedEventCounts = mutableListOf<Long>()
        val job = launch {
            orgRef.snapshots().take(4).collect { snap ->
                snap.getLong("eventCount")?.let { observedEventCounts.add(it) }
            }
        }

        delay(50)

        // Perform 3 collaborative events, each creating an audit record and bumping eventCount
        for (step in 1..3) {
            val batch = clientA.batch()
            val logDoc = auditCol.document("event-$step")
            batch.set(logDoc, mapOf("action" to "action_$step", "timestamp" to FieldValue.serverTimestamp()))
            batch.update(orgRef, mapOf("eventCount" to FieldValue.increment(1L)))
            Tasks.await(batch.commit())
        }

        job.join()

        // Verify parent state
        val parentFinal = Tasks.await(orgRef.get())
        assertEquals(3L, parentFinal.getLong("eventCount"))

        // Verify audit subcollection
        val auditLogs = Tasks.await(auditCol.get())
        assertEquals(3, auditLogs.size())
        assertEquals(listOf(0L, 1L, 2L, 3L), observedEventCounts)
    }

    // ── 6. Client Disconnect and Clean Termination ─────────────────────────

    @Test
    fun testClientLifecycleAndTermination() {
        val ephemeralClient = harness.createClient("ephemeral")
        val docRef = ephemeralClient.collection("lifecycle").document("doc1")

        Tasks.await(docRef.set(mapOf("status" to "alive")))
        assertTrue(Tasks.await(docRef.get()).exists())

        // Terminate client
        Tasks.await(ephemeralClient.terminate())
        assertTrue(ephemeralClient.bridgeClient.isDisposed)
        assertFalse(ephemeralClient.bridgeClient.isConnected)
    }
}
