package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.snapshots
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

@DisplayName("Tier 1 Feature Coverage E2E Tests (Happy Path)")
class Tier1FeatureCoverageE2ETest {

    private lateinit var harness: E2ETestHarness
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        harness = E2ETestHarness()
        firestore = harness.createClient("tier1-app")
    }

    // ── 1. Document CRUD ───────────────────────────────────────────────────

    @Test
    fun testDocumentSetAndGet() {
        val docRef = firestore.collection("users").document("alice")
        Tasks.await(docRef.set(mapOf("name" to "Alice", "age" to 30)))

        val snapshot = Tasks.await(docRef.get())
        assertTrue(snapshot.exists())
        assertEquals("alice", snapshot.id)
        assertEquals("Alice", snapshot.getString("name"))
        assertEquals(30L, snapshot.getLong("age"))
    }

    @Test
    fun testDocumentSetOverwrite() {
        val docRef = firestore.collection("users").document("bob")
        Tasks.await(docRef.set(mapOf("title" to "Engineer", "level" to 5)))
        Tasks.await(docRef.set(mapOf("title" to "Staff Engineer"))) // overwrite

        val snapshot = Tasks.await(docRef.get())
        assertEquals("Staff Engineer", snapshot.getString("title"))
        assertNull(snapshot.get("level"))
    }

    @Test
    fun testDocumentSetMerge() {
        val docRef = firestore.collection("users").document("charlie")
        Tasks.await(docRef.set(mapOf("city" to "Tokyo", "country" to "Japan")))
        Tasks.await(docRef.set(mapOf("city" to "Kyoto", "population" to 1500000), SetOptions.merge()))

        val snapshot = Tasks.await(docRef.get())
        assertEquals("Kyoto", snapshot.getString("city"))
        assertEquals("Japan", snapshot.getString("country"))
        assertEquals(1500000L, snapshot.getLong("population"))
    }

    @Test
    fun testDocumentUpdate() {
        val docRef = firestore.collection("tasks").document("task-1")
        Tasks.await(docRef.set(mapOf("title" to "Write tests", "done" to false)))
        Tasks.await(docRef.update(mapOf("done" to true, "priority" to "high")))

        val snapshot = Tasks.await(docRef.get())
        assertEquals("Write tests", snapshot.getString("title"))
        assertEquals(true, snapshot.getBoolean("done"))
        assertEquals("high", snapshot.getString("priority"))
    }

    @Test
    fun testDocumentUpdateVarargs() {
        val docRef = firestore.collection("tasks").document("task-2")
        Tasks.await(docRef.set(mapOf("name" to "Old Name", "count" to 1)))
        Tasks.await(docRef.update("name", "New Name", "count", 2))

        val snapshot = Tasks.await(docRef.get())
        assertEquals("New Name", snapshot.getString("name"))
        assertEquals(2L, snapshot.getLong("count"))
    }

    @Test
    fun testDocumentDelete() {
        val docRef = firestore.collection("items").document("item-1")
        Tasks.await(docRef.set(mapOf("sku" to "ABC-123")))
        assertTrue(Tasks.await(docRef.get()).exists())

        Tasks.await(docRef.delete())
        val snapshot = Tasks.await(docRef.get())
        assertFalse(snapshot.exists())
        assertNull(snapshot.getData())
    }

    @Test
    fun testDocumentGetNonExistent() {
        val docRef = firestore.collection("items").document("non-existent-item")
        val snapshot = Tasks.await(docRef.get())
        assertFalse(snapshot.exists())
        assertEquals("non-existent-item", snapshot.id)
    }

    @Test
    fun testDocumentSubcollectionCRUD() {
        val subDoc = firestore.collection("users").document("user1")
            .collection("orders").document("order1")
        Tasks.await(subDoc.set(mapOf("total" to 99.50)))

        val snapshot = Tasks.await(subDoc.get())
        assertTrue(snapshot.exists())
        assertEquals(99.50, snapshot.getDouble("total"))
        assertEquals("users/user1/orders/order1", subDoc.path)
    }

    // ── 2. Sentinels ───────────────────────────────────────────────────────

    @Test
    fun testSentinelServerTimestamp() {
        val docRef = firestore.collection("logs").document("log-1")
        Tasks.await(docRef.set(mapOf("event" to "login", "timestamp" to FieldValue.serverTimestamp())))

        val snapshot = Tasks.await(docRef.get())
        val ts = snapshot.getTimestamp("timestamp")
        assertNotNull(ts)
        assertTrue(ts!!.seconds > 0)
    }

    @Test
    fun testSentinelIncrementLong() {
        val docRef = firestore.collection("counters").document("counter-1")
        Tasks.await(docRef.set(mapOf("value" to 10L)))
        Tasks.await(docRef.update(mapOf("value" to FieldValue.increment(5))))

        val snapshot = Tasks.await(docRef.get())
        assertEquals(15L, snapshot.getLong("value"))
    }

    @Test
    fun testSentinelIncrementDouble() {
        val docRef = firestore.collection("metrics").document("temperature")
        Tasks.await(docRef.set(mapOf("temp" to 20.5)))
        Tasks.await(docRef.update(mapOf("temp" to FieldValue.increment(1.5))))

        val snapshot = Tasks.await(docRef.get())
        assertEquals(22.0, snapshot.getDouble("temp"))
    }

    @Test
    fun testSentinelArrayUnion() {
        val docRef = firestore.collection("posts").document("post-1")
        Tasks.await(docRef.set(mapOf("tags" to listOf("kotlin", "firebase"))))
        Tasks.await(docRef.update(mapOf("tags" to FieldValue.arrayUnion("android", "kotlin"))))

        val snapshot = Tasks.await(docRef.get())
        @Suppress("UNCHECKED_CAST")
        val tags = snapshot.get("tags") as List<String>
        assertEquals(listOf("kotlin", "firebase", "android"), tags)
    }

    @Test
    fun testSentinelArrayRemove() {
        val docRef = firestore.collection("posts").document("post-2")
        Tasks.await(docRef.set(mapOf("tags" to listOf("kotlin", "android", "testing"))))
        Tasks.await(docRef.update(mapOf("tags" to FieldValue.arrayRemove("android", "non-existent"))))

        val snapshot = Tasks.await(docRef.get())
        @Suppress("UNCHECKED_CAST")
        val tags = snapshot.get("tags") as List<String>
        assertEquals(listOf("kotlin", "testing"), tags)
    }

    @Test
    fun testSentinelDeleteFieldInUpdate() {
        val docRef = firestore.collection("accounts").document("acc-1")
        Tasks.await(docRef.set(mapOf("active" to true, "tempToken" to "xyz123")))
        Tasks.await(docRef.update(mapOf("tempToken" to FieldValue.delete())))

        val snapshot = Tasks.await(docRef.get())
        assertTrue(snapshot.getData()?.containsKey("active") == true)
        assertFalse(snapshot.getData()?.containsKey("tempToken") == true)
    }

    @Test
    fun testSentinelDeleteFieldInMerge() {
        val docRef = firestore.collection("accounts").document("acc-2")
        Tasks.await(docRef.set(mapOf("active" to true, "tempToken" to "abc456")))
        Tasks.await(docRef.set(mapOf("tempToken" to FieldValue.delete()), SetOptions.merge()))

        val snapshot = Tasks.await(docRef.get())
        assertTrue(snapshot.getData()?.containsKey("active") == true)
        assertFalse(snapshot.getData()?.containsKey("tempToken") == true)
    }

    // ── 3. Compound Queries ────────────────────────────────────────────────

    @Test
    fun testQueryWhereEqualTo() {
        val col = firestore.collection("query-equal")
        Tasks.await(col.document("1").set(mapOf("role" to "admin", "name" to "Alice")))
        Tasks.await(col.document("2").set(mapOf("role" to "member", "name" to "Bob")))

        val querySnap = Tasks.await(col.whereEqualTo("role", "admin").get())
        assertEquals(1, querySnap.size())
        assertEquals("Alice", querySnap.documents[0].getString("name"))
    }

    @Test
    fun testQueryWhereIn() {
        val col = firestore.collection("query-in")
        Tasks.await(col.document("1").set(mapOf("status" to "open")))
        Tasks.await(col.document("2").set(mapOf("status" to "pending")))
        Tasks.await(col.document("3").set(mapOf("status" to "closed")))

        val querySnap = Tasks.await(col.whereIn("status", listOf("open", "closed")).get())
        assertEquals(2, querySnap.size())
    }

    @Test
    fun testQueryWhereNotIn() {
        val col = firestore.collection("query-notin")
        Tasks.await(col.document("1").set(mapOf("status" to "open")))
        Tasks.await(col.document("2").set(mapOf("status" to "pending")))
        Tasks.await(col.document("3").set(mapOf("status" to "closed")))

        val querySnap = Tasks.await(col.whereNotIn("status", listOf("closed")).get())
        assertEquals(2, querySnap.size())
    }

    @Test
    fun testQueryWhereArrayContains() {
        val col = firestore.collection("query-ac")
        Tasks.await(col.document("1").set(mapOf("roles" to listOf("editor", "viewer"))))
        Tasks.await(col.document("2").set(mapOf("roles" to listOf("viewer"))))

        val querySnap = Tasks.await(col.whereArrayContains("roles", "editor").get())
        assertEquals(1, querySnap.size())
        assertEquals("1", querySnap.documents[0].id)
    }

    @Test
    fun testQueryWhereArrayContainsAny() {
        val col = firestore.collection("query-aca")
        Tasks.await(col.document("1").set(mapOf("tags" to listOf("kt", "java"))))
        Tasks.await(col.document("2").set(mapOf("tags" to listOf("swift"))))

        val querySnap = Tasks.await(col.whereArrayContainsAny("tags", listOf("kt", "rust")).get())
        assertEquals(1, querySnap.size())
        assertEquals("1", querySnap.documents[0].id)
    }

    @Test
    fun testQueryOrderByAscendingAndDescending() {
        val col = firestore.collection("query-order")
        Tasks.await(col.document("1").set(mapOf("score" to 10)))
        Tasks.await(col.document("2").set(mapOf("score" to 30)))
        Tasks.await(col.document("3").set(mapOf("score" to 20)))

        val ascSnap = Tasks.await(col.orderBy("score", Query.Direction.ASCENDING).get())
        assertEquals(listOf(10L, 20L, 30L), ascSnap.documents.map { it.getLong("score") })

        val descSnap = Tasks.await(col.orderBy("score", Query.Direction.DESCENDING).get())
        assertEquals(listOf(30L, 20L, 10L), descSnap.documents.map { it.getLong("score") })
    }

    @Test
    fun testQueryLimit() {
        val col = firestore.collection("query-limit")
        for (i in 1..5) {
            Tasks.await(col.document("doc-$i").set(mapOf("val" to i)))
        }

        val snap = Tasks.await(col.orderBy("val").limit(3).get())
        assertEquals(3, snap.size())
        assertEquals(1L, snap.documents.first().getLong("val"))
        assertEquals(3L, snap.documents.last().getLong("val"))
    }

    @Test
    fun testQueryLimitToLast() {
        val col = firestore.collection("query-limit-to-last")
        for (i in 1..5) {
            Tasks.await(col.document("doc-$i").set(mapOf("val" to i)))
        }

        val snap = Tasks.await(col.orderBy("val").limitToLast(2).get())
        assertEquals(2, snap.size())
        assertEquals(4L, snap.documents.first().getLong("val"))
        assertEquals(5L, snap.documents.last().getLong("val"))
    }

    @Test
    fun testQueryStartAtAndStartAfterCursors() {
        val col = firestore.collection("query-cursor")
        for (i in listOf(10, 20, 30, 40)) {
            Tasks.await(col.document("d-$i").set(mapOf("score" to i)))
        }

        val startAtSnap = Tasks.await(col.orderBy("score").startAt(20).get())
        assertEquals(listOf(20L, 30L, 40L), startAtSnap.documents.map { it.getLong("score") })

        val startAfterSnap = Tasks.await(col.orderBy("score").startAfter(20).get())
        assertEquals(listOf(30L, 40L), startAfterSnap.documents.map { it.getLong("score") })
    }

    @Test
    fun testQueryEndBeforeAndEndAtCursors() {
        val col = firestore.collection("query-end-cursors")
        for (i in listOf(10, 20, 30, 40)) {
            Tasks.await(col.document("d-$i").set(mapOf("score" to i)))
        }

        val endAtSnap = Tasks.await(col.orderBy("score").endAt(30).get())
        assertEquals(listOf(10L, 20L, 30L), endAtSnap.documents.map { it.getLong("score") })

        val endBeforeSnap = Tasks.await(col.orderBy("score").endBefore(30).get())
        assertEquals(listOf(10L, 20L), endBeforeSnap.documents.map { it.getLong("score") })
    }

    @Test
    fun testQueryCompositeFilterAndOr() {
        val col = firestore.collection("query-composite")
        Tasks.await(col.document("1").set(mapOf("type" to "fruit", "color" to "red", "stock" to 5)))
        Tasks.await(col.document("2").set(mapOf("type" to "fruit", "color" to "yellow", "stock" to 0)))
        Tasks.await(col.document("3").set(mapOf("type" to "vegetable", "color" to "red", "stock" to 10)))

        val compositeQuery = col.where(
            Filter.and(
                Filter.equalTo("type", "fruit"),
                Filter.or(
                    Filter.equalTo("color", "red"),
                    Filter.equalTo("color", "green")
                )
            )
        )
        val snap = Tasks.await(compositeQuery.get())
        assertEquals(1, snap.size())
        assertEquals("1", snap.documents[0].id)
    }

    @Test
    fun testQueryCollectionGroup() {
        Tasks.await(firestore.collection("teams").document("t1").collection("members").document("m1").set(mapOf("name" to "Sam")))
        Tasks.await(firestore.collection("teams").document("t2").collection("members").document("m2").set(mapOf("name" to "Alex")))

        val groupQuery = firestore.collectionGroup("members")
        val snap = Tasks.await(groupQuery.get())
        assertEquals(2, snap.size())
    }

    // ── 4. Snapshot Streams (Flow) ─────────────────────────────────────────

    @Test
    fun testDocumentSnapshotFlow() = runBlocking(Dispatchers.IO) {
        val docRef = firestore.collection("stream-docs").document("doc-1")
        Tasks.await(docRef.set(mapOf("state" to "initial")))

        val values = mutableListOf<String>()
        val job = launch {
            docRef.snapshots().take(2).collect { snap ->
                snap.getString("state")?.let { values.add(it) }
            }
        }

        kotlinx.coroutines.delay(50)
        Tasks.await(docRef.update(mapOf("state" to "updated")))
        job.join()
        assertEquals(listOf("initial", "updated"), values)
    }

    @Test
    fun testQuerySnapshotFlow() = runBlocking(Dispatchers.IO) {
        val col = firestore.collection("stream-queries")
        Tasks.await(col.document("1").set(mapOf("status" to "open", "num" to 1)))

        val snapshotCounts = mutableListOf<Int>()
        val job = launch {
            col.whereEqualTo("status", "open").snapshots().take(2).collect { snap ->
                snapshotCounts.add(snap.size())
            }
        }

        kotlinx.coroutines.delay(50)
        Tasks.await(col.document("2").set(mapOf("status" to "open", "num" to 2)))
        job.join()
        assertEquals(listOf(1, 2), snapshotCounts)
    }

    // ── 5. Transactions and Batches ────────────────────────────────────────

    @Test
    fun testWriteBatchAtomicCommit() {
        val batch = firestore.batch()
        val docA = firestore.collection("batch-test").document("docA")
        val docB = firestore.collection("batch-test").document("docB")

        batch.set(docA, mapOf("value" to "A"))
        batch.set(docB, mapOf("value" to "B"))
        Tasks.await(batch.commit())

        assertEquals("A", Tasks.await(docA.get()).getString("value"))
        assertEquals("B", Tasks.await(docB.get()).getString("value"))
    }

    @Test
    fun testRunTransactionReadAndWrite() {
        val docRef = firestore.collection("txn-test").document("balance")
        Tasks.await(docRef.set(mapOf("amount" to 100L)))

        val newBalance = Tasks.await(
            firestore.runTransaction { txn ->
                val snap = txn.get(docRef)
                val current = snap.getLong("amount") ?: 0L
                val next = current + 50L
                txn.update(docRef, mapOf("amount" to next))
                next
            }
        )

        assertEquals(150L, newBalance)
        assertEquals(150L, Tasks.await(docRef.get()).getLong("amount"))
    }
}
