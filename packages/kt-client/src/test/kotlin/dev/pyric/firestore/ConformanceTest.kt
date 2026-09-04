package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.SnapshotMetadata
import com.google.firebase.firestore.firestoreSettings
import com.google.firebase.firestore.snapshots
import dev.pyric.codecs.ValueCodec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

class ConformanceTest {
    data class TestUser(var name: String? = null, var age: Int? = null)

    private lateinit var harness: ConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = ConformanceMockHarness()
    }

    private fun constraints(q: Query): List<Map<String, Any?>> {
        @Suppress("UNCHECKED_CAST")
        return q.toTargetDescriptor()["constraints"] as List<Map<String, Any?>>
    }

    private fun lastOp(method: String): Map<String, Any?>? =
        harness.sentMessages.find { it["type"] == "worker-op" && ((it["op"] as? Map<*, *>)?.get("method") == method) }

    private fun encode(v: Any?): Map<String, Any?> {
        @Suppress("UNCHECKED_CAST")
        return ValueCodec.encodeValue(v) as Map<String, Any?>
    }

    // ── 1. FirebaseFirestore: Instance & Lifecycle ─────────────────────────
    @Test
    @DisplayName("firestore-kotlin#1: FirebaseFirestore.getInstance returns default instance")
    fun `firestore-kotlin#1 FirebaseFirestore getInstance returns default instance`() {
        val instance = FirebaseFirestore.getInstance()
        assertNotNull(instance)
        assertEquals("(default)", instance.databaseId)
    }

    @Test
    @DisplayName("firestore-kotlin#2: FirebaseFirestore.getInstance(database) provides isolated instance")
    fun `firestore-kotlin#2 FirebaseFirestore getInstance database provides isolated instance`() {
        val db1 = FirebaseFirestore.getInstance("db-1")
        val db2 = FirebaseFirestore.getInstance("db-2")
        assertNotNull(db1)
        assertNotNull(db2)
        assertNotEquals(db1, db2)
        assertEquals("db-1", db1.databaseId)
        assertEquals("db-2", db2.databaseId)
    }

    @Test
    @DisplayName("firestore-kotlin#3: FirebaseFirestore.firestoreSettings configures host and options")
    fun `firestore-kotlin#3 FirebaseFirestore firestoreSettings configures host and options`() {
        harness.firestore.firestoreSettings = firestoreSettings {
            setHost("127.0.0.1:9999")
            setSslEnabled(true)
            setPersistenceEnabled(false)
        }
        assertEquals("127.0.0.1:9999", harness.firestore.firestoreSettings.host)
        assertTrue(harness.firestore.firestoreSettings.isSslEnabled)
        assertFalse(harness.firestore.firestoreSettings.isPersistenceEnabled)
    }

    @Test
    @DisplayName("firestore-kotlin#4: FirebaseFirestore.document instantiates DocumentReference")
    fun `firestore-kotlin#4 FirebaseFirestore document instantiates DocumentReference`() {
        val ref = harness.firestore.document("users/alovelace")
        assertNotNull(ref)
        assertEquals("alovelace", ref.id)
        assertEquals("users/alovelace", ref.path)
    }

    @Test
    @DisplayName("firestore-kotlin#5: FirebaseFirestore.collection instantiates CollectionReference")
    fun `firestore-kotlin#5 FirebaseFirestore collection instantiates CollectionReference`() {
        val ref = harness.firestore.collection("users")
        assertNotNull(ref)
        assertEquals("users", ref.id)
        assertEquals("users", ref.path)
    }

    @Test
    @DisplayName("firestore-kotlin#6: FirebaseFirestore.collectionGroup instantiates Query")
    fun `firestore-kotlin#6 FirebaseFirestore collectionGroup instantiates Query`() {
        val group = harness.firestore.collectionGroup("messages")
        assertNotNull(group)
        assertEquals("messages", group.collectionId)
        assertTrue(group.isCollectionGroup)
    }

    @Test
    @DisplayName("firestore-kotlin#7: FirebaseFirestore.batch instantiates WriteBatch")
    fun `firestore-kotlin#7 FirebaseFirestore batch instantiates WriteBatch`() {
        assertNotNull(harness.firestore.batch())
    }

    @Test
    @DisplayName("firestore-kotlin#8: FirebaseFirestore.runTransaction executes interactive transaction")
    fun `firestore-kotlin#8 FirebaseFirestore runTransaction executes interactive transaction`() {
        var ran = false
        val task = harness.firestore.runTransaction { ran = true; "txn-result" }
        assertEquals("txn-result", Tasks.await(task))
        assertTrue(ran)
    }

    @Test
    @DisplayName("firestore-kotlin#9: FirebaseFirestore.clearPersistence clears offline cache")
    fun `firestore-kotlin#9 FirebaseFirestore clearPersistence clears offline cache`() {
        Tasks.await(harness.firestore.clearPersistence())
    }

    @Test
    @DisplayName("firestore-kotlin#10: FirebaseFirestore.enableNetwork and disableNetwork toggle network connectivity")
    fun `firestore-kotlin#10 FirebaseFirestore enableNetwork and disableNetwork toggle network connectivity`() {
        Tasks.await(harness.firestore.disableNetwork())
        Tasks.await(harness.firestore.enableNetwork())
    }

    @Test
    @DisplayName("firestore-kotlin#11: FirebaseFirestore.terminate terminates client and releases resources")
    fun `firestore-kotlin#11 FirebaseFirestore terminate terminates client and releases resources`() {
        Tasks.await(harness.firestore.terminate())
        assertTrue(harness.bridgeClient.isDisposed)
    }

    @Test
    @DisplayName("firestore-kotlin#12: FirebaseFirestore.waitForPendingWrites awaits server confirmation")
    fun `firestore-kotlin#12 FirebaseFirestore waitForPendingWrites awaits server confirmation`() {
        Tasks.await(harness.firestore.waitForPendingWrites())
    }

    @Test
    @DisplayName("firestore-kotlin#13: FirebaseFirestore.addSnapshotsInSyncListener notifies listener")
    fun `firestore-kotlin#13 FirebaseFirestore addSnapshotsInSyncListener notifies listener`() {
        val reg = harness.firestore.addSnapshotsInSyncListener { }
        assertNotNull(reg)
        reg.remove()
    }

    // ── 2. DocumentReference: Operations & Flow ────────────────────────────
    @Test
    @DisplayName("firestore-kotlin#14: DocumentReference.get reads document snapshot")
    fun `firestore-kotlin#14 DocumentReference get reads document snapshot`() {
        val snap = Tasks.await(harness.firestore.document("users/alice").get())
        assertTrue(snap.exists())
        assertEquals("Alice", snap.getString("name"))
        assertEquals(30L, snap.getLong("age"))
    }

    @Test
    @DisplayName("firestore-kotlin#15: DocumentReference.set overwrites document data")
    fun `firestore-kotlin#15 DocumentReference set overwrites document data`() {
        Tasks.await(harness.firestore.document("users/alice").set(mapOf("name" to "Alice")))
        assertNotNull(lastOp("setDoc"))
    }

    @Test
    @DisplayName("firestore-kotlin#16: DocumentReference.set with merge preserves unspecified fields")
    fun `firestore-kotlin#16 DocumentReference set with merge preserves unspecified fields`() {
        Tasks.await(harness.firestore.document("users/alice").set(mapOf("age" to 31), SetOptions.merge()))
        val op = lastOp("setDoc")!!["op"] as Map<*, *>
        assertEquals(true, op["merge"])
    }

    @Test
    @DisplayName("firestore-kotlin#17: DocumentReference.update modifies existing fields")
    fun `firestore-kotlin#17 DocumentReference update modifies existing fields`() {
        Tasks.await(harness.firestore.document("users/alice").update("age", 32))
        assertNotNull(lastOp("updateDoc"))
    }

    @Test
    @DisplayName("firestore-kotlin#18: DocumentReference.delete removes document")
    fun `firestore-kotlin#18 DocumentReference delete removes document`() {
        Tasks.await(harness.firestore.document("users/alice").delete())
        assertNotNull(lastOp("deleteDoc"))
    }

    @Test
    @DisplayName("firestore-kotlin#19: DocumentReference.collection returns child CollectionReference")
    fun `firestore-kotlin#19 DocumentReference collection returns child CollectionReference`() {
        val collRef = harness.firestore.document("users/alice").collection("orders")
        assertEquals("users/alice/orders", collRef.path)
        assertEquals("orders", collRef.id)
    }

    @Test
    @DisplayName("firestore-kotlin#20: DocumentReference.snapshots emits Flow of DocumentSnapshot")
    fun `firestore-kotlin#20 DocumentReference snapshots emits Flow of DocumentSnapshot`() = runBlocking {
        val snap = harness.firestore.document("todos/task1").snapshots().first()
        assertTrue(snap.exists())
        assertEquals("online", snap.getString("status"))
    }

    // ── 3. Query: Filters, Ordering, Cursors & Flow ────────────────────────
    @Test
    @DisplayName("firestore-kotlin#21: Query.whereEqualTo filters documents by equality")
    fun `firestore-kotlin#21 Query whereEqualTo filters documents by equality`() {
        val q = harness.firestore.collection("users").whereEqualTo("age", 25)
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "==" && it["field"] == "age" && it["value"] == 25 })
    }

    @Test
    @DisplayName("firestore-kotlin#22: Query.whereNotEqualTo filters documents by inequality")
    fun `firestore-kotlin#22 Query whereNotEqualTo filters documents by inequality`() {
        val q = harness.firestore.collection("users").whereNotEqualTo("status", "inactive")
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "!=" && it["field"] == "status" })
    }

    @Test
    @DisplayName("firestore-kotlin#23: Query.whereLessThan filters range")
    fun `firestore-kotlin#23 Query whereLessThan filters range`() {
        val q = harness.firestore.collection("users").whereLessThan("score", 100)
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "<" && it["field"] == "score" && it["value"] == 100 })
    }

    @Test
    @DisplayName("firestore-kotlin#24: Query.whereLessThanOrEqualTo filters inclusive range")
    fun `firestore-kotlin#24 Query whereLessThanOrEqualTo filters inclusive range`() {
        val q = harness.firestore.collection("users").whereLessThanOrEqualTo("score", 100)
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "<=" && it["field"] == "score" })
    }

    @Test
    @DisplayName("firestore-kotlin#25: Query.whereGreaterThan filters range")
    fun `firestore-kotlin#25 Query whereGreaterThan filters range`() {
        val q = harness.firestore.collection("users").whereGreaterThan("score", 50)
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == ">" && it["field"] == "score" })
    }

    @Test
    @DisplayName("firestore-kotlin#26: Query.whereGreaterThanOrEqualTo filters inclusive range")
    fun `firestore-kotlin#26 Query whereGreaterThanOrEqualTo filters inclusive range`() {
        val q = harness.firestore.collection("users").whereGreaterThanOrEqualTo("score", 50)
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == ">=" && it["field"] == "score" })
    }

    @Test
    @DisplayName("firestore-kotlin#27: Query.whereArrayContains filters array field membership")
    fun `firestore-kotlin#27 Query whereArrayContains filters array field membership`() {
        val q = harness.firestore.collection("posts").whereArrayContains("tags", "news")
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "array-contains" && it["value"] == "news" })
    }

    @Test
    @DisplayName("firestore-kotlin#28: Query.whereArrayContainsAny filters multiple membership")
    fun `firestore-kotlin#28 Query whereArrayContainsAny filters multiple membership`() {
        val q = harness.firestore.collection("posts").whereArrayContainsAny("tags", listOf("news", "tech"))
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "array-contains-any" })
    }

    @Test
    @DisplayName("firestore-kotlin#29: Query.whereIn filters membership in value set")
    fun `firestore-kotlin#29 Query whereIn filters membership in value set`() {
        val q = harness.firestore.collection("posts").whereIn("category", listOf("sports", "music"))
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "in" })
    }

    @Test
    @DisplayName("firestore-kotlin#30: Query.whereNotIn filters exclusion from value set")
    fun `firestore-kotlin#30 Query whereNotIn filters exclusion from value set`() {
        val q = harness.firestore.collection("posts").whereNotIn("category", listOf("spam", "trash"))
        assertTrue(constraints(q).any { it["kind"] == "where" && it["op"] == "not-in" })
    }

    @Test
    @DisplayName("firestore-kotlin#31: Query.where(Filter) supports composite and/or filters")
    fun `firestore-kotlin#31 Query where Filter supports composite and or filters`() {
        val filter = Filter.and(Filter.equalTo("a", 1), Filter.equalTo("b", 2))
        val q = harness.firestore.collection("users").where(filter)
        assertTrue(constraints(q).any { it["kind"] == "and" })
    }

    @Test
    @DisplayName("firestore-kotlin#32: Query.orderBy specifies sort field and direction")
    fun `firestore-kotlin#32 Query orderBy specifies sort field and direction`() {
        val q = harness.firestore.collection("users").orderBy("createdAt", Query.Direction.DESCENDING)
        assertTrue(constraints(q).any { it["kind"] == "orderBy" && it["field"] == "createdAt" && it["direction"] == "desc" })
    }

    @Test
    @DisplayName("firestore-kotlin#33: Query.limit truncates result set")
    fun `firestore-kotlin#33 Query limit truncates result set`() {
        val q = harness.firestore.collection("users").limit(10)
        assertTrue(constraints(q).any { it["kind"] == "limit" && it["n"] == 10L })
    }

    @Test
    @DisplayName("firestore-kotlin#34: Query.limitToLast truncates from end")
    fun `firestore-kotlin#34 Query limitToLast truncates from end`() {
        val q = harness.firestore.collection("users").orderBy("score").limitToLast(5)
        assertTrue(constraints(q).any { it["kind"] == "limitToLast" && it["n"] == 5L })
    }

    @Test
    @DisplayName("firestore-kotlin#35: Query.startAt and startAfter position boundary cursor")
    fun `firestore-kotlin#35 Query startAt and startAfter position boundary cursor`() {
        val q = harness.firestore.collection("users").orderBy("score").startAt(100)
        assertTrue(constraints(q).any { it["kind"] == "startAt" && ((it["values"] as? List<*>)?.get(0) == 100) })
    }

    @Test
    @DisplayName("firestore-kotlin#36: Query.get and Query.snapshots return QuerySnapshot and Flow")
    fun `firestore-kotlin#36 Query get and Query snapshots return QuerySnapshot and Flow`() = runBlocking {
        val q = harness.firestore.collection("users")
        assertEquals(2, Tasks.await(q.get()).size())
        assertEquals(1, q.snapshots().first().size())
    }

    // ── 4. CollectionReference: Path Navigation & Insertion ────────────────
    @Test
    @DisplayName("firestore-kotlin#37: CollectionReference.document auto-generates or parses id")
    fun `firestore-kotlin#37 CollectionReference document auto-generates or parses id`() {
        val coll = harness.firestore.collection("users")
        val doc1 = coll.document()
        val doc2 = coll.document("custom-id")
        assertEquals(20, doc1.id.length)
        assertEquals("custom-id", doc2.id)
        assertEquals("users/custom-id", doc2.path)
    }

    @Test
    @DisplayName("firestore-kotlin#38: CollectionReference.add generates id and creates document")
    fun `firestore-kotlin#38 CollectionReference add generates id and creates document`() {
        val docRef = Tasks.await(harness.firestore.collection("todos").add(mapOf("title" to "Buy milk")))
        assertNotNull(docRef)
        assertEquals("todos", docRef.parent.id)
    }

    // ── 5. Snapshots & Metadata ────────────────────────────────────────────
    @Test
    @DisplayName("firestore-kotlin#39: DocumentSnapshot.exists reports presence or absence")
    fun `firestore-kotlin#39 DocumentSnapshot exists reports presence or absence`() {
        val snap = Tasks.await(harness.firestore.document("users/alice").get())
        assertTrue(snap.exists())
    }

    @Test
    @DisplayName("firestore-kotlin#40: DocumentSnapshot.getData returns document data map")
    fun `firestore-kotlin#40 DocumentSnapshot getData returns document data map`() {
        val snap = Tasks.await(harness.firestore.document("users/alice").get())
        val data = snap.getData()
        assertNotNull(data)
        assertEquals("Alice", data!!["name"])
        assertEquals(30, data["age"])
    }

    @Test
    @DisplayName("firestore-kotlin#41: DocumentSnapshot.get extracts nested field by path")
    fun `firestore-kotlin#41 DocumentSnapshot get extracts nested field by path`() {
        val snap = Tasks.await(harness.firestore.document("users/alice").get())
        assertEquals("Alice", snap.getString("name"))
        assertEquals(30L, snap.getLong("age"))
    }

    @Test
    @DisplayName("firestore-kotlin#42: DocumentSnapshot.toObject deserializes data into typed object")
    fun `firestore-kotlin#42 DocumentSnapshot toObject deserializes data into typed object`() {
        val snap = Tasks.await(harness.firestore.document("users/alice").get())
        val user = snap.toObject(TestUser::class.java)
        assertNotNull(user)
        assertEquals("Alice", user!!.name)
        assertEquals(30, user.age)
    }

    @Test
    @DisplayName("firestore-kotlin#43: SnapshotMetadata exposes hasPendingWrites and isFromCache")
    fun `firestore-kotlin#43 SnapshotMetadata exposes hasPendingWrites and isFromCache`() {
        val meta = SnapshotMetadata(hasPendingWrites = true, isFromCache = false)
        assertTrue(meta.hasPendingWrites())
        assertFalse(meta.isFromCache())
        assertTrue(meta.hasPendingWrites)
        assertFalse(meta.isFromCache)
    }

    @Test
    @DisplayName("firestore-kotlin#44: QuerySnapshot getDocuments and getDocumentChanges expose results")
    fun `firestore-kotlin#44 QuerySnapshot getDocuments and getDocumentChanges expose results`() {
        val snap = Tasks.await(harness.firestore.collection("users").get())
        assertEquals(2, snap.getDocuments().size)
        assertEquals("1", snap.getDocuments()[0].id)
        assertEquals("2", snap.getDocuments()[1].id)
    }

    // ── 6. WriteBatch: Atomic Mutations ────────────────────────────────────
    @Test
    @DisplayName("firestore-kotlin#45: WriteBatch.set queues overwrite or merge write")
    fun `firestore-kotlin#45 WriteBatch set queues overwrite or merge write`() {
        val batch = harness.firestore.batch()
        batch.set(harness.firestore.document("users/a"), mapOf("name" to "A"))
        Tasks.await(batch.commit())
        assertNotNull(lastOp("batchCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#46: WriteBatch.update queues partial field updates")
    fun `firestore-kotlin#46 WriteBatch update queues partial field updates`() {
        val batch = harness.firestore.batch()
        batch.update(harness.firestore.document("users/a"), mapOf("name" to "A2"))
        Tasks.await(batch.commit())
        assertNotNull(lastOp("batchCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#47: WriteBatch.delete queues document deletion")
    fun `firestore-kotlin#47 WriteBatch delete queues document deletion`() {
        val batch = harness.firestore.batch()
        batch.delete(harness.firestore.document("users/a"))
        Tasks.await(batch.commit())
        assertNotNull(lastOp("batchCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#48: WriteBatch.commit applies all queued mutations atomically")
    fun `firestore-kotlin#48 WriteBatch commit applies all queued mutations atomically`() {
        val batch = harness.firestore.batch()
        batch.set(harness.firestore.document("users/1"), mapOf("k" to "v"))
        Tasks.await(batch.commit())
        assertThrows(IllegalStateException::class.java) { batch.commit() }
    }

    // ── 7. Transaction: Concurrent Read/Write & Retries ────────────────────
    @Test
    @DisplayName("firestore-kotlin#49: Transaction.get performs transactional document read")
    fun `firestore-kotlin#49 Transaction get performs transactional document read`() {
        val ref = harness.firestore.document("users/alice")
        val task = harness.firestore.runTransaction { txn -> txn.get(ref).getString("name") }
        assertEquals("Alice", Tasks.await(task))
    }

    @Test
    @DisplayName("firestore-kotlin#50: Transaction.set stages document write in transaction")
    fun `firestore-kotlin#50 Transaction set stages document write in transaction`() {
        val ref = harness.firestore.document("users/alice")
        val task = harness.firestore.runTransaction { txn -> txn.set(ref, mapOf("counter" to 1)); null }
        Tasks.await(task)
        assertNotNull(lastOp("txnCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#51: Transaction.update stages partial update in transaction")
    fun `firestore-kotlin#51 Transaction update stages partial update in transaction`() {
        val ref = harness.firestore.document("users/alice")
        val task = harness.firestore.runTransaction { txn -> txn.update(ref, mapOf("counter" to 2)); null }
        Tasks.await(task)
        assertNotNull(lastOp("txnCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#52: Transaction.delete stages deletion in transaction")
    fun `firestore-kotlin#52 Transaction delete stages deletion in transaction`() {
        val ref = harness.firestore.document("users/alice")
        val task = harness.firestore.runTransaction { txn -> txn.delete(ref); null }
        Tasks.await(task)
        assertNotNull(lastOp("txnCommit"))
    }

    @Test
    @DisplayName("firestore-kotlin#53: Transaction retry mechanism retries on conflict")
    fun `firestore-kotlin#53 Transaction retry mechanism retries on conflict`() {
        var attempts = 0
        val task = harness.firestore.runTransaction { txn ->
            attempts++
            if (attempts < 2) {
                throw RuntimeException("Temporary conflict")
            }
            "recovered"
        }
        val result = Tasks.await(task)
        assertEquals("recovered", result)
        assertEquals(2, attempts)
    }

    // ── 8. FieldValue: Sentinel Values ─────────────────────────────────────
    @Test
    @DisplayName("firestore-kotlin#54: FieldValue.serverTimestamp encodes server timestamp sentinel")
    fun `firestore-kotlin#54 FieldValue serverTimestamp encodes server timestamp sentinel`() {
        assertEquals("serverTimestamp", encode(FieldValue.serverTimestamp())["__sentinel"])
    }

    @Test
    @DisplayName("firestore-kotlin#55: FieldValue.delete encodes field deletion sentinel")
    fun `firestore-kotlin#55 FieldValue delete encodes field deletion sentinel`() {
        assertEquals("deleteField", encode(FieldValue.delete())["__sentinel"])
    }

    @Test
    @DisplayName("firestore-kotlin#56: FieldValue.increment encodes atomic numeric increment")
    fun `firestore-kotlin#56 FieldValue increment encodes atomic numeric increment`() {
        assertEquals(5L, encode(FieldValue.increment(5L))["n"])
        assertEquals(2.5, encode(FieldValue.increment(2.5))["n"])
    }

    @Test
    @DisplayName("firestore-kotlin#57: FieldValue.arrayUnion encodes array union sentinel")
    fun `firestore-kotlin#57 FieldValue arrayUnion encodes array union sentinel`() {
        assertEquals(listOf("a", 1), encode(FieldValue.arrayUnion("a", 1))["values"])
    }

    @Test
    @DisplayName("firestore-kotlin#58: FieldValue.arrayRemove encodes array remove sentinel")
    fun `firestore-kotlin#58 FieldValue arrayRemove encodes array remove sentinel`() {
        assertEquals(listOf("b", 2), encode(FieldValue.arrayRemove("b", 2))["values"])
    }

    // ── 9. Value Codecs: Timestamps, GeoPoints, Blobs & References ─────────
    @Test
    @DisplayName("firestore-kotlin#59: Timestamp encodes and decodes seconds and nanoseconds")
    fun `firestore-kotlin#59 Timestamp encodes and decodes seconds and nanoseconds`() {
        val ts = Timestamp(1710000000L, 500)
        val encoded = encode(ts)
        assertEquals(1710000000L, encoded["seconds"])
        assertEquals(500, encoded["nanos"])
        assertEquals(ts, ValueCodec.decodeValue(encoded))
    }

    @Test
    @DisplayName("firestore-kotlin#60: GeoPoint encodes and decodes latitude and longitude")
    fun `firestore-kotlin#60 GeoPoint encodes and decodes latitude and longitude`() {
        val gp = GeoPoint(37.7749, -122.4194)
        val encoded = encode(gp)
        assertEquals(37.7749, encoded["lat"])
        assertEquals(-122.4194, encoded["lng"])
        assertEquals(gp, ValueCodec.decodeValue(encoded))
    }

    @Test
    @DisplayName("firestore-kotlin#61: Blob encodes and decodes byte arrays as base64url")
    fun `firestore-kotlin#61 Blob encodes and decodes byte arrays as base64url`() {
        val bytes = byteArrayOf(1, 2, 3)
        val encoded = encode(Blob.fromBytes(bytes))
        assertArrayEquals(bytes, (ValueCodec.decodeValue(encoded) as Blob).toBytes())
    }

    @Test
    @DisplayName("firestore-kotlin#62: DocumentReference encodes and revives reference paths")
    fun `firestore-kotlin#62 DocumentReference encodes and revives reference paths`() {
        val ref = harness.firestore.document("users/alice")
        val decoded = ValueCodec.decodeValue(encode(ref)) { harness.firestore.document(it) } as DocumentReference
        assertEquals(ref, decoded)
    }

    @Test
    @DisplayName("firestore-kotlin#63: Nested map and array serialization preserves types recursively")
    fun `firestore-kotlin#63 Nested map and array serialization preserves types recursively`() {
        val map = mapOf("ts" to Timestamp(100L, 0), "items" to listOf(Blob.fromBytes(byteArrayOf(4, 5))))
        @Suppress("UNCHECKED_CAST")
        val decoded = ValueCodec.decodeValue(ValueCodec.encodeValue(map)) as Map<String, Any?>
        assertEquals(Timestamp(100L, 0), decoded["ts"])
        assertArrayEquals(byteArrayOf(4, 5), ((decoded["items"] as List<*>)[0] as Blob).toBytes())
    }

    // ── 10. Aggregations: Count & Numeric Aggregates ────────────────────────
    @Test
    @DisplayName("firestore-kotlin#64: AggregateQuery.count executes count aggregation")
    fun `firestore-kotlin#64 AggregateQuery count executes count aggregation`() {
        val snap = Tasks.await(harness.firestore.collection("users").count().get())
        assertEquals(42L, snap.count)
        assertEquals(42L, snap.get(AggregateField.count()))
    }

    @Test
    @DisplayName("firestore-kotlin#65: AggregateQuery.aggregate computes sum and average")
    fun `firestore-kotlin#65 AggregateQuery aggregate computes sum and average`() {
        val snap = Tasks.await(harness.firestore.collection("scores").aggregate(AggregateField.sum("score"), AggregateField.average("score")).get())
        assertEquals(150.0, snap.get(AggregateField.sum("score")))
        assertEquals(75.0, snap.get(AggregateField.average("score")))
    }
}
