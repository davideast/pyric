package dev.pyric.database

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import dev.pyric.auth.AuthLens
import dev.pyric.database.internal.RtdbInMemoryWorker
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test

class RtdbConformanceTest {
    private lateinit var worker: RtdbInMemoryWorker
    private lateinit var database: FirebaseDatabase
    private lateinit var app: FirebaseApp

    @BeforeEach
    fun setUp() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        worker = RtdbInMemoryWorker()
        app = FirebaseApp.initializeApp(
            "rtdb-test-app",
            FirebaseOptions.Builder()
                .setProjectId("rtdb-project")
                .setApiKey("rtdb-key")
                .setApplicationId("rtdb-app-id")
                .build()
        )
        database = FirebaseDatabase.getInstance(
            app = app,
            bridgeClient = worker.createBridgeClient(),
            url = "https://rtdb-project-default-rtdb.firebaseio.com"
        )
    }

    // ── Section 1: Database Instance & Connection (5 rows) ──────────────────

    @Test
    @DisplayName("rtdb-kotlin#instance-default: FirebaseDatabase.getInstance returns default instance")
    fun `rtdb-kotlin#instance-default FirebaseDatabase getInstance returns default instance`() {
        val defaultDb = FirebaseDatabase.getInstance()
        assertNotNull(defaultDb)
        assertEquals(FirebaseDatabase.DEFAULT_DATABASE_URL, defaultDb.url)
    }

    @Test
    @DisplayName("rtdb-kotlin#instance-url: FirebaseDatabase.getInstance(url) returns isolated instance")
    fun `rtdb-kotlin#instance-url FirebaseDatabase getInstance url returns isolated instance`() {
        val customUrl = "https://custom-instance.firebaseio.com"
        val customDb = FirebaseDatabase.getInstance(app, worker.createBridgeClient(), customUrl)
        assertNotNull(customDb)
        assertEquals(customUrl, customDb.url)
        assertNotEquals(database.url, customDb.url)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-root: FirebaseDatabase.reference returns root DatabaseReference")
    fun `rtdb-kotlin#ref-root FirebaseDatabase reference returns root DatabaseReference`() {
        val rootRef = database.reference
        assertEquals("", rootRef.path)
        assertNull(rootRef.key)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-path: FirebaseDatabase.getReference(path) targets path")
    fun `rtdb-kotlin#ref-path FirebaseDatabase getReference path targets path`() {
        val ref = database.getReference("users/alice/profile")
        assertEquals("users/alice/profile", ref.path)
        assertEquals("profile", ref.key)
    }

    @Test
    @DisplayName("rtdb-kotlin#connection-toggle: goOffline and goOnline toggle connection")
    fun `rtdb-kotlin#connection-toggle goOffline and goOnline toggle connection`() = runBlocking {
        database.goOffline()
        Thread.sleep(50)
        assertTrue(worker.isOffline)
        assertTrue(worker.recordedOps.any { it.method == "rtdb.goOffline" })

        database.goOnline()
        Thread.sleep(50)
        assertFalse(worker.isOffline)
        assertTrue(worker.recordedOps.any { it.method == "rtdb.goOnline" })
    }

    // ── Section 2: DatabaseReference Navigation & Properties (7 rows) ───────

    @Test
    @DisplayName("rtdb-kotlin#ref-child: DatabaseReference.child navigates relative path")
    fun `rtdb-kotlin#ref-child DatabaseReference child navigates relative path`() {
        val usersRef = database.getReference("users")
        val aliceRef = usersRef.child("alice/settings")
        assertEquals("users/alice/settings", aliceRef.path)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-parent: DatabaseReference.parent navigates up or returns null at root")
    fun `rtdb-kotlin#ref-parent DatabaseReference parent navigates up or returns null at root`() {
        val childRef = database.getReference("users/alice")
        val parentRef = childRef.parent
        assertNotNull(parentRef)
        assertEquals("users", parentRef?.path)
        assertNull(database.reference.parent)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-root-prop: DatabaseReference.root returns root reference")
    fun `rtdb-kotlin#ref-root-prop DatabaseReference root returns root reference`() {
        val deepRef = database.getReference("a/b/c/d")
        val rootRef = deepRef.root
        assertEquals("", rootRef.path)
        assertNull(rootRef.key)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-key: DatabaseReference.key returns last segment or null for root")
    fun `rtdb-kotlin#ref-key DatabaseReference key returns last segment or null for root`() {
        assertNull(database.reference.key)
        assertEquals("items", database.getReference("items").key)
        assertEquals("item-42", database.getReference("items/item-42").key)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-path-prop: DatabaseReference.path returns slash-delimited path")
    fun `rtdb-kotlin#ref-path-prop DatabaseReference path returns slash-delimited path`() {
        val ref = database.getReference("/posts/2026/title/")
        assertEquals("posts/2026/title", ref.path)
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-push: DatabaseReference.push generates unique child reference")
    fun `rtdb-kotlin#ref-push DatabaseReference push generates unique child reference`() {
        val listRef = database.getReference("messages")
        val pushed1 = listRef.push()
        val pushed2 = listRef.push()
        assertNotNull(pushed1.key)
        assertNotNull(pushed2.key)
        assertNotEquals(pushed1.key, pushed2.key)
        assertTrue(pushed1.path.startsWith("messages/"))
    }

    @Test
    @DisplayName("rtdb-kotlin#ref-push-key-ordering: push keys sort chronologically and lexicographically")
    fun `rtdb-kotlin#ref-push-key-ordering push keys sort chronologically and lexicographically`() {
        val listRef = database.getReference("events")
        val keys = (1..10).map { listRef.push().key!! }
        val sorted = keys.sorted()
        assertEquals(sorted, keys)
    }

    // ── Section 3: Write Operations (6 rows) ────────────────────────────────

    @Test
    @DisplayName("rtdb-kotlin#write-set: DatabaseReference.setValue writes value at path")
    fun `rtdb-kotlin#write-set DatabaseReference setValue writes value at path`() {
        val ref = database.getReference("users/u1")
        Tasks.await(ref.setValue(mapOf("name" to "Ada", "role" to "admin")))
        val snap = Tasks.await(ref.get())
        assertTrue(snap.exists())
        assertEquals("Ada", snap.child("name").value)
    }

    @Test
    @DisplayName("rtdb-kotlin#write-set-null: DatabaseReference.setValue(null) deletes node")
    fun `rtdb-kotlin#write-set-null DatabaseReference setValue null deletes node`() {
        val ref = database.getReference("temp/node")
        Tasks.await(ref.setValue("to-be-deleted"))
        assertTrue(Tasks.await(ref.get()).exists())
        Tasks.await(ref.setValue(null))
        assertFalse(Tasks.await(ref.get()).exists())
    }

    @Test
    @DisplayName("rtdb-kotlin#write-set-priority: DatabaseReference.setPriority updates node priority")
    fun `rtdb-kotlin#write-set-priority DatabaseReference setPriority updates node priority`() {
        val ref = database.getReference("ranked/item1")
        Tasks.await(ref.setValue("alpha"))
        Tasks.await(ref.setPriority(100L))
        val snap = Tasks.await(ref.get())
        assertEquals(100L, (snap.priority as? Number)?.toLong())
    }

    @Test
    @DisplayName("rtdb-kotlin#write-set-with-priority: setValue with priority stores value and priority")
    fun `rtdb-kotlin#write-set-with-priority setValue with priority stores value and priority`() {
        val ref = database.getReference("ranked/item2")
        Tasks.await(ref.setValue("beta", 50L))
        val snap = Tasks.await(ref.get())
        assertEquals("beta", snap.value)
        assertEquals(50L, (snap.priority as? Number)?.toLong())
    }

    @Test
    @DisplayName("rtdb-kotlin#write-update: updateChildren merges specified child paths")
    fun `rtdb-kotlin#write-update updateChildren merges specified child paths`() {
        val ref = database.getReference("profile/p1")
        Tasks.await(ref.setValue(mapOf("name" to "Grace", "city" to "NYC")))
        Tasks.await(ref.updateChildren(mapOf("city" to "Boston", "title" to "Admiral")))
        val snap = Tasks.await(ref.get())
        assertEquals("Grace", snap.child("name").value)
        assertEquals("Boston", snap.child("city").value)
        assertEquals("Admiral", snap.child("title").value)
    }

    @Test
    @DisplayName("rtdb-kotlin#write-remove: removeValue deletes node at reference")
    fun `rtdb-kotlin#write-remove removeValue deletes node at reference`() {
        val ref = database.getReference("sessions/s1")
        Tasks.await(ref.setValue("active"))
        Tasks.await(ref.removeValue())
        val snap = Tasks.await(ref.get())
        assertFalse(snap.exists())
    }

    // ── Section 4: ServerValue Sentinels (2 rows) ───────────────────────────

    @Test
    @DisplayName("rtdb-kotlin#sentinel-timestamp: ServerValue.TIMESTAMP resolves to epoch millis")
    fun `rtdb-kotlin#sentinel-timestamp ServerValue TIMESTAMP resolves to epoch millis`() {
        val ref = database.getReference("logs/entry1/createdAt")
        Tasks.await(ref.setValue(ServerValue.TIMESTAMP))
        val snap = Tasks.await(ref.get())
        val ts = (snap.value as? Number)?.toLong()
        assertNotNull(ts)
        assertTrue(ts!! > 1700000000000L)
    }

    @Test
    @DisplayName("rtdb-kotlin#sentinel-increment: ServerValue.increment atomically adds delta")
    fun `rtdb-kotlin#sentinel-increment ServerValue increment atomically adds delta`() {
        val ref = database.getReference("counters/visits")
        Tasks.await(ref.setValue(10L))
        Tasks.await(ref.setValue(ServerValue.increment(5L)))
        val snap = Tasks.await(ref.get())
        assertEquals(15L, (snap.value as? Number)?.toLong())
    }

    // ── Section 5: One-Shot Reads & DataSnapshot Inspection (7 rows) ────────

    @Test
    @DisplayName("rtdb-kotlin#read-get: Query.get retrieves one-shot DataSnapshot")
    fun `rtdb-kotlin#read-get Query get retrieves one-shot DataSnapshot`() {
        val ref = database.getReference("config/version")
        Tasks.await(ref.setValue("2.1.0"))
        val snap = Tasks.await(ref.get())
        assertEquals("2.1.0", snap.value)
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-exists: DataSnapshot.exists reflects non-null data")
    fun `rtdb-kotlin#snap-exists DataSnapshot exists reflects non-null data`() {
        val ref = database.getReference("check/flag")
        assertFalse(Tasks.await(ref.get()).exists())
        Tasks.await(ref.setValue(true))
        assertTrue(Tasks.await(ref.get()).exists())
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-key: DataSnapshot.key returns node key")
    fun `rtdb-kotlin#snap-key DataSnapshot key returns node key`() {
        val ref = database.getReference("books/b99")
        Tasks.await(ref.setValue("Dune"))
        val snap = Tasks.await(ref.get())
        assertEquals("b99", snap.key)
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-value: DataSnapshot.getValue returns scalar or typed value")
    fun `rtdb-kotlin#snap-value DataSnapshot getValue returns scalar or typed value`() {
        val ref = database.getReference("stats/score")
        Tasks.await(ref.setValue(42L))
        val snap = Tasks.await(ref.get())
        assertEquals(42L, snap.getValue(Long::class.java))
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-children: DataSnapshot.children iterates immediate child snapshots")
    fun `rtdb-kotlin#snap-children DataSnapshot children iterates immediate child snapshots`() {
        val ref = database.getReference("teams")
        Tasks.await(ref.setValue(mapOf("a" to "Alpha", "b" to "Beta")))
        val snap = Tasks.await(ref.get())
        assertEquals(2L, snap.childrenCount)
        val keys = snap.children.map { it.key }
        assertEquals(listOf("a", "b"), keys)
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-child-path: DataSnapshot.child navigates nested child path")
    fun `rtdb-kotlin#snap-child-path DataSnapshot child navigates nested child path`() {
        val ref = database.getReference("org")
        Tasks.await(ref.setValue(mapOf("dept" to mapOf("lead" to "Linus"))))
        val snap = Tasks.await(ref.get())
        assertTrue(snap.hasChild("dept/lead"))
        assertEquals("Linus", snap.child("dept/lead").value)
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-priority: DataSnapshot.priority exposes node priority")
    fun `rtdb-kotlin#snap-priority DataSnapshot priority exposes node priority`() {
        val ref = database.getReference("tasks/t1")
        Tasks.await(ref.setValue("urgent", 1L))
        val snap = Tasks.await(ref.get())
        assertEquals(1L, (snap.priority as? Number)?.toLong())
    }

    // ── Section 6: Realtime Listeners & Streams (5 rows) ────────────────────

    @Test
    @DisplayName("rtdb-kotlin#listen-value: ValueEventListener and snapshots Flow emit live updates")
    fun `rtdb-kotlin#listen-value ValueEventListener and snapshots Flow emit live updates`() = runBlocking {
        val ref = database.getReference("live/status")
        Tasks.await(ref.setValue("initial"))
        val snap = withTimeout(2000) { ref.snapshots().first() }
        assertEquals("initial", snap.value)
    }

    @Test
    @DisplayName("rtdb-kotlin#listen-child-added: ChildEventListener fires onChildAdded for children")
    fun `rtdb-kotlin#listen-child-added ChildEventListener fires onChildAdded for children`() = runBlocking {
        val ref = database.getReference("chat/room1")
        Tasks.await(ref.setValue(mapOf("m1" to "Hello")))
        val event = withTimeout(2000) { ref.childEvents().first() }
        assertTrue(event is ChildEvent.Added)
        assertEquals("m1", event.snapshot.key)
        assertEquals("Hello", event.snapshot.value)
    }

    @Test
    @DisplayName("rtdb-kotlin#listen-child-changed: ChildEventListener fires onChildChanged on child update")
    fun `rtdb-kotlin#listen-child-changed ChildEventListener fires onChildChanged on child update`() = runBlocking {
        val ref = database.getReference("items")
        Tasks.await(ref.setValue(mapOf("i1" to "v1")))
        val changedDeferred = CompletableDeferred<DataSnapshot>()
        val listener = ref.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                changedDeferred.complete(snapshot)
            }
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        Thread.sleep(50)
        Tasks.await(ref.child("i1").setValue("v2"))
        val changedSnap = withTimeout(2000) { changedDeferred.await() }
        assertEquals("v2", changedSnap.value)
        ref.removeEventListener(listener)
    }

    @Test
    @DisplayName("rtdb-kotlin#listen-child-removed: ChildEventListener fires onChildRemoved when child deleted")
    fun `rtdb-kotlin#listen-child-removed ChildEventListener fires onChildRemoved when child deleted`() = runBlocking {
        val ref = database.getReference("queue")
        Tasks.await(ref.setValue(mapOf("job1" to "running")))
        val removedDeferred = CompletableDeferred<DataSnapshot>()
        val listener = ref.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {
                removedDeferred.complete(snapshot)
            }
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        Thread.sleep(50)
        Tasks.await(ref.child("job1").removeValue())
        val removedSnap = withTimeout(2000) { removedDeferred.await() }
        assertEquals("job1", removedSnap.key)
        ref.removeEventListener(listener)
    }

    @Test
    @DisplayName("rtdb-kotlin#listen-cancel: removeEventListener detaches active listener")
    fun `rtdb-kotlin#listen-cancel removeEventListener detaches active listener`() = runBlocking {
        val ref = database.getReference("stream/cancelTest")
        var count = 0
        val listener = ref.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                count++
            }
            override fun onCancelled(error: DatabaseError) {}
        })
        Thread.sleep(50)
        ref.removeEventListener(listener)
        val countAfterRemove = count
        Tasks.await(ref.setValue("after-cancel"))
        Thread.sleep(50)
        assertEquals(countAfterRemove, count)
    }

    // ── Section 7: Query Ordering, Filtering & Limits (6 rows) ──────────────

    @Test
    @DisplayName("rtdb-kotlin#query-order-by-child: orderByChild sorts results by nested child field")
    fun `rtdb-kotlin#query-order-by-child orderByChild sorts results by nested child field`() {
        val ref = database.getReference("players")
        Tasks.await(ref.setValue(mapOf(
            "p1" to mapOf("score" to 30),
            "p2" to mapOf("score" to 10),
            "p3" to mapOf("score" to 20)
        )))
        val snap = Tasks.await(ref.orderByChild("score").get())
        assertEquals(listOf("p2", "p3", "p1"), snap.children.map { it.key })
    }

    @Test
    @DisplayName("rtdb-kotlin#query-order-by-key: orderByKey sorts results lexicographically by key")
    fun `rtdb-kotlin#query-order-by-key orderByKey sorts results lexicographically by key`() {
        val ref = database.getReference("letters")
        Tasks.await(ref.setValue(mapOf("c" to 1, "a" to 2, "b" to 3)))
        val snap = Tasks.await(ref.orderByKey().get())
        assertEquals(listOf("a", "b", "c"), snap.children.map { it.key })
    }

    @Test
    @DisplayName("rtdb-kotlin#query-order-by-value: orderByValue sorts results by primitive value")
    fun `rtdb-kotlin#query-order-by-value orderByValue sorts results by primitive value`() {
        val ref = database.getReference("scores")
        Tasks.await(ref.setValue(mapOf("alice" to 50, "bob" to 10, "carol" to 30)))
        val snap = Tasks.await(ref.orderByValue().get())
        assertEquals(listOf("bob", "carol", "alice"), snap.children.map { it.key })
    }

    @Test
    @DisplayName("rtdb-kotlin#query-equal-to: equalTo filters children matching value")
    fun `rtdb-kotlin#query-equal-to equalTo filters children matching value`() {
        val ref = database.getReference("usersByRole")
        Tasks.await(ref.setValue(mapOf(
            "u1" to mapOf("role" to "editor"),
            "u2" to mapOf("role" to "admin"),
            "u3" to mapOf("role" to "editor")
        )))
        val snap = Tasks.await(ref.orderByChild("role").equalTo("editor").get())
        assertEquals(listOf("u1", "u3"), snap.children.map { it.key })
    }

    @Test
    @DisplayName("rtdb-kotlin#query-range: startAt and endAt filter inclusive range window")
    fun `rtdb-kotlin#query-range startAt and endAt filter inclusive range window`() {
        val ref = database.getReference("numbers")
        Tasks.await(ref.setValue(mapOf("n1" to 10, "n2" to 20, "n3" to 30, "n4" to 40)))
        val snap = Tasks.await(ref.orderByValue().startAt(20).endAt(30).get())
        assertEquals(listOf("n2", "n3"), snap.children.map { it.key })
    }

    @Test
    @DisplayName("rtdb-kotlin#query-limit: limitToFirst and limitToLast bound result count")
    fun `rtdb-kotlin#query-limit limitToFirst and limitToLast bound result count`() {
        val ref = database.getReference("series")
        Tasks.await(ref.setValue(mapOf("a" to 1, "b" to 2, "c" to 3, "d" to 4)))
        val firstTwo = Tasks.await(ref.orderByKey().limitToFirst(2).get())
        val lastTwo = Tasks.await(ref.orderByKey().limitToLast(2).get())
        assertEquals(listOf("a", "b"), firstTwo.children.map { it.key })
        assertEquals(listOf("c", "d"), lastTwo.children.map { it.key })
    }

    // ── Section 8: Transactions & OnDisconnect (4 rows) ─────────────────────

    @Test
    @DisplayName("rtdb-kotlin#tx-run: runTransaction commits atomic update and returns snapshot")
    fun `rtdb-kotlin#tx-run runTransaction commits atomic update and returns snapshot`() = runBlocking {
        val ref = database.getReference("bank/balance")
        Tasks.await(ref.setValue(100L))
        val done = CompletableDeferred<DataSnapshot?>()
        ref.runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                val cur = (currentData.value as? Number)?.toLong() ?: 0L
                currentData.value = cur + 50L
                return Transaction.success(currentData)
            }
            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                done.complete(currentData)
            }
        })
        val finalSnap = withTimeout(2000) { done.await() }
        assertEquals(150L, (finalSnap?.value as? Number)?.toLong())
    }

    @Test
    @DisplayName("rtdb-kotlin#tx-abort: Transaction.abort cancels transaction without modifying data")
    fun `rtdb-kotlin#tx-abort Transaction abort cancels transaction without modifying data`() = runBlocking {
        val ref = database.getReference("bank/locked")
        Tasks.await(ref.setValue(500L))
        val done = CompletableDeferred<Boolean>()
        ref.runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                return Transaction.abort()
            }
            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                done.complete(committed)
            }
        })
        val committed = withTimeout(2000) { done.await() }
        assertFalse(committed)
        assertEquals(500L, (Tasks.await(ref.get()).value as? Number)?.toLong())
    }

    @Test
    @DisplayName("rtdb-kotlin#ondisconnect-set-remove: OnDisconnect queues operations executed on disconnect")
    fun `rtdb-kotlin#ondisconnect-set-remove OnDisconnect queues operations executed on disconnect`() {
        val statusRef = database.getReference("presence/u1")
        Tasks.await(statusRef.setValue("online"))
        Tasks.await(statusRef.onDisconnect().setValue("offline"))
        database.goOffline()
        Thread.sleep(50)
        database.goOnline()
        val snap = Tasks.await(statusRef.get())
        assertEquals("offline", snap.value)
    }

    @Test
    @DisplayName("rtdb-kotlin#ondisconnect-cancel: OnDisconnect.cancel clears scheduled disconnect action")
    fun `rtdb-kotlin#ondisconnect-cancel OnDisconnect cancel clears scheduled disconnect action`() {
        val statusRef = database.getReference("presence/u2")
        Tasks.await(statusRef.setValue("online"))
        Tasks.await(statusRef.onDisconnect().setValue("offline"))
        Tasks.await(statusRef.onDisconnect().cancel())
        database.goOffline()
        Thread.sleep(50)
        database.goOnline()
        val snap = Tasks.await(statusRef.get())
        assertEquals("online", snap.value)
    }

    // ── AuthLens Propagation Verification ───────────────────────────────────

    @Test
    @DisplayName("AuthLens propagation attaches active lens and re-evaluates active subscriptions")
    fun `authLens propagation attaches active lens and re-evaluates active subscriptions`() = runBlocking {
        val ref = database.getReference("secure/data")
        database.setAuthLens(AuthLens.Admin)
        Tasks.await(ref.setValue("secret"))
        val lastAdminOp = worker.recordedOps.last { it.method == "rtdb.set" }
        assertEquals("admin", lastAdminOp.actAs?.get("mode"))

        database.setAuthLens(AuthLens.AsUser(uid = "alice-123"))
        Tasks.await(ref.get())
        val lastUserOp = worker.recordedOps.last { it.method == "rtdb.get" }
        assertEquals("as", lastUserOp.actAs?.get("mode"))
        assertEquals("alice-123", lastUserOp.actAs?.get("uid"))

        // Verify subscription re-evaluation on identity change
        val listener = ref.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        Thread.sleep(50)
        val initialSub = worker.recordedSubs.last()
        assertEquals("as", initialSub.actAs?.get("mode"))

        database.setAuthLens(AuthLens.Anon)
        Thread.sleep(80)
        val reevaluatedSub = worker.recordedSubs.last()
        assertEquals("anon", reevaluatedSub.actAs?.get("mode"))
        ref.removeEventListener(listener)
    }
}
