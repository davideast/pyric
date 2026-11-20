package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.ChildEvent
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseException
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.MutableData
import com.google.firebase.database.ServerValue
import com.google.firebase.database.Transaction
import com.google.firebase.database.ValueEventListener
import com.google.firebase.database.childEvents
import com.google.firebase.database.database
import com.google.firebase.database.getValue
import com.google.firebase.database.snapshots
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Live-host conformance suite for rtdb-kotlin Sections 1-8 against a running Pyric Node host:
 * 1. Database Instance & Connection (instance-default, instance-url, ref-root, ref-path, connection-toggle, info-connected)
 * 2. DatabaseReference Navigation & Properties (ref-child, ref-parent, ref-root-prop, ref-key, ref-path-prop, ref-push, ref-push-key-ordering)
 * 3. Write Operations (write-set, write-set-null, write-set-priority, write-set-with-priority, write-update, write-remove)
 * 4. ServerValue Sentinels (sentinel-timestamp, sentinel-increment)
 * 5. One-Shot Reads & DataSnapshot Inspection (read-get, snap-exists, snap-key, snap-value, snap-children, snap-child-path, snap-priority)
 * 6. Realtime Listeners & Streams (listen-value, listen-child-added, listen-child-changed, listen-child-removed, listen-cancel)
 * 7. Query Ordering, Filtering & Limits (query-order-by-child, query-order-by-key, query-order-by-value, query-equal-to, query-range, query-limit)
 * 8. Transactions & OnDisconnect (tx-run, tx-abort, ondisconnect-set-remove, ondisconnect-cancel)
 */
class RtdbLiveHostConformanceTest {
    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var userEmail: String
    private lateinit var uid: String

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping RTDB live-host conformance test"
        )
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        val defaultApp = FirebaseApp.initializeApp(
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.rtdb")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        liveBridgeUrl = envUrl
        userEmail = "rtdb-live-${System.nanoTime()}@example.com"
        val client = PyricBridgeClient(url = envUrl)
        bridgeClient = client
        val auth = FirebaseAuth.getInstance(defaultApp, client)
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(
                userEmail,
                USER_PASSWORD
            ),
            10,
            TimeUnit.SECONDS
        )
        uid = requireNotNull(created.user).uid
    }

    @AfterEach
    fun tearDown() {
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        bridgeClient = null
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `proves Section 1 instance, root and path refs, info-connected, and goOffline-goOnline on live host`() {
        // instance-default: FirebaseDatabase.getInstance() / Firebase.database
        val defaultDb = FirebaseDatabase.getInstance()
        assertSame(defaultDb, Firebase.database)
        assertSame(bridgeClient, defaultDb.bridgeClient)
        assertEquals("https://$PROJECT_ID-default-rtdb.firebaseio.com", defaultDb.url)

        // instance-url: FirebaseDatabase.getInstance(url) / Firebase.database(url) + trailing-slash normalization
        val shard00Url = "https://$PROJECT_ID-shard-00.firebaseio.com"
        val shard00 = FirebaseDatabase.getInstance("$shard00Url/")
        assertEquals(shard00Url, shard00.url)
        assertSame(shard00, Firebase.database(shard00Url))
        assertNotEquals(defaultDb.url, shard00.url)
        assertSame(defaultDb.bridgeClient, shard00.bridgeClient)

        // Fresh named FirebaseApp where FirebaseDatabase.getInstance(freshApp) runs BEFORE FirebaseAuth.getInstance(freshApp)
        // with zero explicit PyricBridgeClient construction in caller code.
        val freshApp = FirebaseApp.initializeApp(
            "fresh-zero-bridge-app-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.fresh")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com/")
                .build()
        )
        val freshDb = FirebaseDatabase.getInstance(freshApp)
        val freshAuth = FirebaseAuth.getInstance(freshApp)
        assertEquals("https://$PROJECT_ID-default-rtdb.firebaseio.com", freshDb.url)
        assertSame(freshDb.bridgeClient, freshAuth.bridgeClient)
        val freshCreated = Tasks.await(
            freshAuth.createUserWithEmailAndPassword(
                "fresh-bootstrap-${System.nanoTime()}@example.com",
                "FreshBoot!123"
            ),
            10,
            TimeUnit.SECONDS
        )
        val freshUid = requireNotNull(freshCreated.user).uid
        Tasks.await(
            freshDb.getReference("profiles/$freshUid/bootstrap").setValue("ok"),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(
            "ok",
            Tasks.await(freshDb.getReference("profiles/$freshUid/bootstrap").get(), 10, TimeUnit.SECONDS).value
        )

        // ref-root & ref-path
        val rootRef = defaultDb.reference
        assertEquals("", rootRef.path)
        assertNull(rootRef.key)

        val profileRef = defaultDb.getReference("/profiles/$uid/status/")
        assertEquals("profiles/$uid/status", profileRef.path)
        assertEquals("status", profileRef.key)

        // Write via defaultDb and shard00 to prove live-host isolation on 0-arg/1-arg getInstance
        Tasks.await(profileRef.setValue("online"), 10, TimeUnit.SECONDS)
        assertEquals("online", Tasks.await(profileRef.get(), 10, TimeUnit.SECONDS).value)

        val roomMemberRef = shard00.getReference("rooms/room-a/members/$uid")
        Tasks.await(roomMemberRef.setValue(mapOf("state" to "joined")), 10, TimeUnit.SECONDS)
        assertEquals("joined", Tasks.await(roomMemberRef.get(), 10, TimeUnit.SECONDS).child("state").value)

        // info-connected + connection-toggle (goOffline drains onDisconnect on live host, turns .info/connected false, goOnline restores true)
        val connectedRef = defaultDb.getReference(".info/connected")
        val seenConnected = CopyOnWriteArrayList<Boolean>()
        val connectedListener = connectedRef.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val boolVal = snapshot.getValue(Boolean::class.java)
                if (boolVal != null) {
                    seenConnected.add(boolVal)
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        try {
            awaitCondition("initial .info/connected == true") {
                seenConnected.lastOrNull() == true
            }
            assertEquals(true, Tasks.await(connectedRef.get(), 5, TimeUnit.SECONDS).value)

            Tasks.await(profileRef.onDisconnect().setValue("offline"), 10, TimeUnit.SECONDS)

            defaultDb.goOffline()
            awaitCondition(".info/connected == false after goOffline") {
                seenConnected.lastOrNull() == false
            }
            assertEquals(false, Tasks.await(connectedRef.get(), 5, TimeUnit.SECONDS).value)

            defaultDb.goOnline()
            awaitCondition(".info/connected == true after goOnline") {
                seenConnected.lastOrNull() == true
            }
            assertEquals(true, Tasks.await(connectedRef.get(), 5, TimeUnit.SECONDS).value)

            // Verify live host executed the queued onDisconnect write when defaultDb went offline
            awaitCondition("onDisconnect setValue('offline') flushed on live host") {
                Tasks.await(profileRef.get(), 10, TimeUnit.SECONDS).value == "offline"
            }
            assertTrue(
                seenConnected.zipWithNext().none { (a, b) -> a == b },
                "Expected no duplicate consecutive .info/connected emissions: $seenConnected"
            )
        } finally {
            connectedRef.removeEventListener(connectedListener)
        }
    }

    @Test
    fun `proves Section 2 reference navigation and monotonic push ordering on live host`() {
        val db = Firebase.database
        val userRoot = db.getReference("profiles/$uid")
        val itemsRef = userRoot.child("/items/list/")

        // ref-child, ref-path-prop, ref-key, ref-parent, ref-root-prop
        assertEquals("profiles/$uid/items/list", itemsRef.path)
        assertEquals("list", itemsRef.key)
        assertEquals("profiles/$uid/items", itemsRef.parent?.path)
        assertEquals("profiles/$uid", itemsRef.parent?.parent?.path)
        assertEquals("", itemsRef.root.path)
        assertNull(itemsRef.root.parent)
        assertNull(itemsRef.root.key)

        // ref-push & ref-push-key-ordering persisted and read back from live host
        val generatedKeys = mutableListOf<String>()
        for (i in 1..6) {
            val pushedRef = itemsRef.push()
            val key = requireNotNull(pushedRef.key)
            assertTrue(key.isNotBlank())
            assertEquals("profiles/$uid/items/list/$key", pushedRef.path)
            generatedKeys.add(key)
            Tasks.await(
                pushedRef.setValue(mapOf("seq" to i.toLong(), "label" to "item-$i")),
                10,
                TimeUnit.SECONDS
            )
        }

        assertEquals(6, generatedKeys.toSet().size)
        assertEquals(generatedKeys.sorted(), generatedKeys)

        val listSnap = Tasks.await(itemsRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(listSnap.exists())
        assertEquals(6L, listSnap.childrenCount)
        assertEquals(generatedKeys, listSnap.children.map { it.key })
    }

    @Test
    fun `proves Section 3 write operations and Section 4 ServerValue sentinels on live host`() {
        val db = Firebase.database
        val baseRef = db.getReference("profiles/$uid/writes")

        // write-set
        val itemRef = baseRef.child("item-1")
        Tasks.await(
            itemRef.setValue(mapOf("title" to "Initial", "views" to 1L)),
            10,
            TimeUnit.SECONDS
        )
        val initialSnap = Tasks.await(itemRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(initialSnap.exists())
        assertEquals("Initial", initialSnap.child("title").value)
        assertEquals(1L, initialSnap.child("views").getValue(Long::class.java))

        // write-update (preserves omitted siblings, updates specified keys)
        Tasks.await(
            itemRef.updateChildren(mapOf("title" to "Updated", "tag" to "pinned")),
            10,
            TimeUnit.SECONDS
        )
        val updatedSnap = Tasks.await(itemRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("Updated", updatedSnap.child("title").value)
        assertEquals(1L, updatedSnap.child("views").getValue(Long::class.java))
        assertEquals("pinned", updatedSnap.child("tag").value)

        // write-set-priority (updates priority without altering value)
        val rankedRef = baseRef.child("ranked-a")
        Tasks.await(rankedRef.setValue("alpha"), 10, TimeUnit.SECONDS)
        Tasks.await(rankedRef.setPriority(40.0), 10, TimeUnit.SECONDS)
        val rankedSnap = Tasks.await(rankedRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("alpha", rankedSnap.value)
        assertEquals(40.0, (rankedSnap.priority as? Number)?.toDouble())

        // write-set-with-priority (writes value + priority atomically; also check child priority via parent snapshot)
        val rankedWithPrioRef = baseRef.child("ranked-b")
        Tasks.await(rankedWithPrioRef.setValue("beta", 10.0), 10, TimeUnit.SECONDS)
        val rankedWithPrioSnap = Tasks.await(rankedWithPrioRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("beta", rankedWithPrioSnap.value)
        assertEquals(10.0, (rankedWithPrioSnap.priority as? Number)?.toDouble())

        val parentSnap = Tasks.await(baseRef.get(), 10, TimeUnit.SECONDS)
        assertEquals(10.0, (parentSnap.child("ranked-b").priority as? Number)?.toDouble())

        // write-set-null (deletes node)
        Tasks.await(rankedRef.setValue(null), 10, TimeUnit.SECONDS)
        assertFalse(Tasks.await(rankedRef.get(), 10, TimeUnit.SECONDS).exists())

        // write-remove (removes node and descendants)
        Tasks.await(itemRef.removeValue(), 10, TimeUnit.SECONDS)
        assertFalse(Tasks.await(itemRef.get(), 10, TimeUnit.SECONDS).exists())

        // sentinel-timestamp: ServerValue.TIMESTAMP resolves to epoch millis on live host
        val tsRef = baseRef.child("metrics/updatedAt")
        val beforeWriteMs = System.currentTimeMillis() - 60_000L
        Tasks.await(tsRef.setValue(ServerValue.TIMESTAMP), 10, TimeUnit.SECONDS)
        val resolvedTs = Tasks.await(tsRef.get(), 10, TimeUnit.SECONDS).getValue(Long::class.java)
        assertNotNull(resolvedTs)
        assertTrue(resolvedTs!! >= beforeWriteMs, "Expected server timestamp >= $beforeWriteMs, got $resolvedTs")

        // sentinel-increment: ServerValue.increment(Long) and ServerValue.increment(Double) on live host
        val counterRef = baseRef.child("metrics/count")
        Tasks.await(counterRef.setValue(10L), 10, TimeUnit.SECONDS)
        Tasks.await(counterRef.setValue(ServerValue.increment(7L)), 10, TimeUnit.SECONDS)
        assertEquals(17L, Tasks.await(counterRef.get(), 10, TimeUnit.SECONDS).getValue(Long::class.java))

        val floatCounterRef = baseRef.child("metrics/score")
        Tasks.await(floatCounterRef.setValue(2.5), 10, TimeUnit.SECONDS)
        Tasks.await(floatCounterRef.setValue(ServerValue.increment(1.25)), 10, TimeUnit.SECONDS)
        assertEquals(3.75, Tasks.await(floatCounterRef.get(), 10, TimeUnit.SECONDS).getValue(Double::class.java))

        // Verify unauthorized write rejects with DatabaseException (PERMISSION_DENIED)
        val deniedExec = try {
            Tasks.await(
                db.getReference("profiles/other-user/writes").setValue("forbidden"),
                10,
                TimeUnit.SECONDS
            )
            null
        } catch (err: ExecutionException) {
            err
        }
        assertNotNull(deniedExec)
        val deniedCause = requireNotNull(deniedExec?.cause)
        assertTrue(deniedCause is DatabaseException)
        assertEquals(DatabaseError.PERMISSION_DENIED, DatabaseError.fromException(deniedCause).code)
    }

    @Test
    fun `proves Section 5 one-shot reads and DataSnapshot inspection on live host`() {
        val db = Firebase.database
        val snapRoot = db.getReference("profiles/$uid/snapshots")

        // read-get & snap-exists on missing path
        val missingSnap = Tasks.await(snapRoot.child("missing").get(), 10, TimeUnit.SECONDS)
        assertFalse(missingSnap.exists())
        assertNull(missingSnap.value)
        assertNull(missingSnap.getValue(false))
        assertEquals(0L, missingSnap.childrenCount)
        assertFalse(missingSnap.hasChildren())
        assertNull(missingSnap.priority)

        // snap-exists on falsy non-null scalars (false and 0)
        Tasks.await(snapRoot.child("boolFalse").setValue(false), 10, TimeUnit.SECONDS)
        val falseSnap = Tasks.await(snapRoot.child("boolFalse").get(), 10, TimeUnit.SECONDS)
        assertTrue(falseSnap.exists())
        assertEquals(false, falseSnap.getValue(Boolean::class.java))
        assertEquals(false, falseSnap.getValue<Boolean>())

        Tasks.await(snapRoot.child("zeroLong").setValue(0L), 10, TimeUnit.SECONDS)
        val zeroSnap = Tasks.await(snapRoot.child("zeroLong").get(), 10, TimeUnit.SECONDS)
        assertTrue(zeroSnap.exists())
        assertEquals(0L, zeroSnap.getValue(Long::class.java))
        assertEquals(0, zeroSnap.getValue(Int::class.java))
        assertEquals(0L, zeroSnap.getValue<Long>())

        // snap-key (root key is null; non-root key is last segment)
        assertNull(db.reference.key)
        assertEquals("snapshots", snapRoot.key)
        assertEquals("boolFalse", falseSnap.key)

        // snap-value, snap-child-path, snap-children (including RTDB numeric-first key order), and snap-priority
        val orgRef = snapRoot.child("org")
        Tasks.await(
            orgRef.setValue(
                mapOf(
                    "dept" to mapOf(
                        "lead" to mapOf("name" to "Ada", "years" to 7L),
                        "tags" to listOf("core", "realtime")
                    ),
                    "buckets" to mapOf(
                        "10" to "ten",
                        "2" to "two",
                        "alpha" to "first-alpha",
                        "beta" to "second-alpha"
                    )
                )
            ),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(orgRef.child("dept/pinned").setValue("urgent", "p0"), 10, TimeUnit.SECONDS)
        Tasks.await(orgRef.child("rankedChild").setValue("gold", 5.5), 10, TimeUnit.SECONDS)

        val orgSnap = Tasks.await(orgRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(orgSnap.exists())
        assertEquals("org", orgSnap.key)
        assertTrue(orgSnap.hasChildren())
        assertTrue(orgSnap.hasChild("dept/lead/name"))
        assertFalse(orgSnap.hasChild("dept/lead/nonexistent"))

        val leadNameSnap = orgSnap.child("dept/lead/name")
        assertTrue(leadNameSnap.exists())
        assertEquals("name", leadNameSnap.key)
        assertEquals("Ada", leadNameSnap.value)
        assertEquals("Ada", leadNameSnap.getValue(String::class.java))
        assertEquals("Ada", leadNameSnap.getValue<String>())
        assertEquals(7L, orgSnap.child("dept/lead/years").getValue<Long>())

        val missingDescendant = orgSnap.child("dept/lead/nonexistent")
        assertFalse(missingDescendant.exists())
        assertNull(missingDescendant.value)

        // Nested map children follow RTDB numeric-first key ordering ("2" before "10" before "alpha")
        val bucketsSnap = orgSnap.child("buckets")
        assertEquals(4L, bucketsSnap.childrenCount)
        assertEquals(listOf("2", "10", "alpha", "beta"), bucketsSnap.children.map { it.key })
        assertEquals(listOf("two", "ten", "first-alpha", "second-alpha"), bucketsSnap.children.map { it.value })

        // snap-priority & export format on direct and nested child snapshots
        val rankedSnap = Tasks.await(orgRef.child("rankedChild").get(), 10, TimeUnit.SECONDS)
        assertEquals(5.5, (rankedSnap.priority as? Number)?.toDouble())
        assertEquals(
            mapOf(".value" to "gold", ".priority" to 5.5),
            rankedSnap.getValue(true)
        )
        assertEquals("gold", rankedSnap.getValue(false))

        assertEquals(5.5, (orgSnap.child("rankedChild").priority as? Number)?.toDouble())
        assertEquals("p0", orgSnap.child("dept/pinned").priority)
        assertNull(orgSnap.child("dept/lead/name").priority)
    }

    @Test
    fun `proves Section 6 realtime value and child listeners, Flow streams, and cancellation on live host`() {
        val db = Firebase.database
        val streamScope = CoroutineScope(Dispatchers.IO)

        // listen-value: Query.snapshots Flow, addValueEventListener, addListenerForSingleValueEvent, and onCancelled
        val statusRef = db.getReference("profiles/$uid/streams/status")
        Tasks.await(statusRef.setValue("initial"), 10, TimeUnit.SECONDS)

        val flowValues = CopyOnWriteArrayList<Any?>()
        val valueFlowJob = streamScope.launch {
            statusRef.snapshots.collect { snap ->
                flowValues.add(snap.value)
            }
        }

        val callbackValues = CopyOnWriteArrayList<Any?>()
        val valueListener = statusRef.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                callbackValues.add(snapshot.value)
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        val singleShotValues = CopyOnWriteArrayList<Any?>()
        statusRef.addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                singleShotValues.add(snapshot.value)
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        awaitCondition("initial value delivered to Flow, ValueEventListener, and single-value listener") {
            flowValues.contains("initial") && callbackValues.contains("initial") && singleShotValues.size == 1
        }
        assertEquals(listOf<Any?>("initial"), singleShotValues)

        Tasks.await(statusRef.setValue("updated-1"), 10, TimeUnit.SECONDS)
        awaitCondition("updated-1 delivered to Flow and ValueEventListener") {
            flowValues.lastOrNull() == "updated-1" && callbackValues.lastOrNull() == "updated-1"
        }
        // Single-value listener must NOT fire again
        assertEquals(1, singleShotValues.size)

        // Unauthorized listeners deliver onCancelled(PERMISSION_DENIED) across Value, SingleValue, and Child listeners
        val deniedFuture = CompletableFuture<DatabaseError>()
        val deniedRef = db.getReference("profiles/other-user/privateStream")
        val deniedListener = deniedRef.addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {
                deniedFuture.complete(error)
            }
        })
        val deniedErr = deniedFuture.get(10, TimeUnit.SECONDS)
        assertEquals(DatabaseError.PERMISSION_DENIED, deniedErr.code)
        deniedRef.removeEventListener(deniedListener)

        val deniedSingleFuture = CompletableFuture<DatabaseError>()
        deniedRef.addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {
                deniedSingleFuture.complete(error)
            }
        })
        assertEquals(DatabaseError.PERMISSION_DENIED, deniedSingleFuture.get(10, TimeUnit.SECONDS).code)

        val deniedChildFuture = CompletableFuture<DatabaseError>()
        val deniedChildListener = deniedRef.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {
                deniedChildFuture.complete(error)
            }
        })
        assertEquals(DatabaseError.PERMISSION_DENIED, deniedChildFuture.get(10, TimeUnit.SECONDS).code)
        deniedRef.removeEventListener(deniedChildListener)

        // listen-child-added, listen-child-changed (and Moved), listen-child-removed
        val catalogRef = db.getReference("profiles/$uid/catalog")
        Tasks.await(
            catalogRef.setValue(
                mapOf(
                    "item-a" to mapOf("score" to 10L, "label" to "Alpha"),
                    "item-b" to mapOf("score" to 30L, "label" to "Beta")
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        val orderedQuery = catalogRef.orderByChild("score")
        val childFlowEvents = CopyOnWriteArrayList<ChildEvent>()
        val childFlowJob = streamScope.launch {
            orderedQuery.childEvents.collect { ev ->
                childFlowEvents.add(ev)
            }
        }

        val addedKeys = CopyOnWriteArrayList<Pair<String?, String?>>()
        val changedKeys = CopyOnWriteArrayList<Pair<String?, Any?>>()
        val movedKeys = CopyOnWriteArrayList<Pair<String?, String?>>()
        val removedKeys = CopyOnWriteArrayList<String?>()
        val childListener = orderedQuery.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                addedKeys.add(snapshot.key to previousChildName)
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                changedKeys.add(snapshot.key to snapshot.child("score").getValue<Long>())
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {
                removedKeys.add(snapshot.key)
            }

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                movedKeys.add(snapshot.key to previousChildName)
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        awaitCondition("initial ChildEvent.Added for item-a and item-b") {
            addedKeys.size >= 2 && childFlowEvents.count { it is ChildEvent.Added } >= 2
        }
        assertEquals(listOf("item-a" to null, "item-b" to "item-a"), addedKeys.take(2))

        // Add item-c with score 20 -> inserted after item-a
        Tasks.await(
            catalogRef.child("item-c").setValue(mapOf("score" to 20L, "label" to "Gamma")),
            10,
            TimeUnit.SECONDS
        )
        awaitCondition("ChildEvent.Added for item-c after item-a") {
            addedKeys.any { it.first == "item-c" } &&
                childFlowEvents.any { it is ChildEvent.Added && it.snapshot.key == "item-c" }
        }
        assertTrue(addedKeys.contains("item-c" to "item-a"))

        // Update item-a score from 10 -> 40 -> triggers Changed AND Moved (now after item-b)
        Tasks.await(
            catalogRef.child("item-a").updateChildren(mapOf("score" to 40L)),
            10,
            TimeUnit.SECONDS
        )
        awaitCondition("ChildEvent.Changed and Moved for item-a") {
            changedKeys.any { it.first == "item-a" && it.second == 40L } &&
                movedKeys.any { it.first == "item-a" && it.second == "item-b" } &&
                childFlowEvents.any { it is ChildEvent.Changed && it.snapshot.key == "item-a" } &&
                childFlowEvents.any { it is ChildEvent.Moved && it.snapshot.key == "item-a" }
        }

        // Remove item-c -> triggers ChildEvent.Removed
        Tasks.await(catalogRef.child("item-c").removeValue(), 10, TimeUnit.SECONDS)
        awaitCondition("ChildEvent.Removed for item-c") {
            removedKeys.contains("item-c") &&
                childFlowEvents.any { it is ChildEvent.Removed && it.snapshot.key == "item-c" }
        }

        // listen-cancel: removeEventListener + coroutine Job.cancel() stops all further emissions
        statusRef.removeEventListener(valueListener)
        orderedQuery.removeEventListener(childListener)
        valueFlowJob.cancel()
        childFlowJob.cancel()

        // Allow unsub frames to flush to host by performing a roundtrip op
        val roundtripMarkerRef = db.getReference("profiles/$uid/streams/roundtripMarker")
        Tasks.await(roundtripMarkerRef.setValue("flushed-unsub"), 10, TimeUnit.SECONDS)
        assertEquals("flushed-unsub", Tasks.await(roundtripMarkerRef.get(), 10, TimeUnit.SECONDS).value)

        val callbackCountAtCancel = callbackValues.size
        val flowCountAtCancel = flowValues.size
        val addedCountAtCancel = addedKeys.size
        val removedCountAtCancel = removedKeys.size
        val childFlowCountAtCancel = childFlowEvents.size

        Tasks.await(statusRef.setValue("after-cancel"), 10, TimeUnit.SECONDS)
        Tasks.await(
            catalogRef.child("item-after-cancel").setValue(mapOf("score" to 5L, "label" to "PostCancel")),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(catalogRef.child("item-b").removeValue(), 10, TimeUnit.SECONDS)
        Tasks.await(roundtripMarkerRef.setValue("flushed-post-writes"), 10, TimeUnit.SECONDS)
        assertEquals("flushed-post-writes", Tasks.await(roundtripMarkerRef.get(), 10, TimeUnit.SECONDS).value)

        assertEquals(callbackCountAtCancel, callbackValues.size)
        assertEquals(flowCountAtCancel, flowValues.size)
        assertEquals(addedCountAtCancel, addedKeys.size)
        assertEquals(removedCountAtCancel, removedKeys.size)
        assertEquals(childFlowCountAtCancel, childFlowEvents.size)

        // Cleanup catalog before next test
        Tasks.await(catalogRef.removeValue(), 10, TimeUnit.SECONDS)
    }

    @Test
    fun `proves Section 7 query ordering, equalTo, range cursors, and limits on live host`() {
        val db = Firebase.database
        val catalogRef = db.getReference("profiles/$uid/catalog")

        Tasks.await(
            catalogRef.setValue(
                mapOf(
                    "item-a" to mapOf("score" to 10L, "role" to "member", "meta" to mapOf("rank" to 5L)),
                    "item-b" to mapOf("score" to 20L, "role" to "editor", "meta" to mapOf("rank" to 4L)),
                    "item-c" to mapOf("score" to 30L, "role" to "admin", "meta" to mapOf("rank" to 2L)),
                    "item-d" to mapOf("score" to 20L, "role" to "editor", "meta" to mapOf("rank" to 3L)),
                    "item-e" to mapOf("score" to 50L, "role" to "owner", "meta" to mapOf("rank" to 1L))
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        // query-order-by-child (direct field + nested slash path, with deterministic key tie-break)
        val byScoreSnap = Tasks.await(catalogRef.orderByChild("score").get(), 10, TimeUnit.SECONDS)
        assertEquals(
            listOf("item-a", "item-b", "item-d", "item-c", "item-e"),
            byScoreSnap.children.map { it.key }
        )

        val byNestedRankSnap = Tasks.await(catalogRef.orderByChild("/meta/rank/").get(), 10, TimeUnit.SECONDS)
        assertEquals(
            listOf("item-e", "item-c", "item-d", "item-b", "item-a"),
            byNestedRankSnap.children.map { it.key }
        )

        // Unindexed orderByChild get() rejects with DatabaseException on live host
        val unindexedRef = db.getReference("profiles/$uid/unindexedItems")
        Tasks.await(unindexedRef.setValue(mapOf("x" to mapOf("score" to 1L))), 10, TimeUnit.SECONDS)
        val unindexedExec = assertThrows(ExecutionException::class.java) {
            Tasks.await(unindexedRef.orderByChild("score").get(), 10, TimeUnit.SECONDS)
        }
        assertTrue(unindexedExec.cause is DatabaseException)

        // query-order-by-key (numeric keys sort numerically before lexicographic keys)
        val keyedRef = db.getReference("profiles/$uid/keyedSeries")
        Tasks.await(
            keyedRef.setValue(mapOf("10" to "ten", "2" to "two", "beta" to "b", "alpha" to "a")),
            10,
            TimeUnit.SECONDS
        )
        val byKeySnap = Tasks.await(keyedRef.orderByKey().get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("2", "10", "alpha", "beta"), byKeySnap.children.map { it.key })

        // query-order-by-value
        val scoresRef = db.getReference("profiles/$uid/scores")
        Tasks.await(
            scoresRef.setValue(mapOf("u1" to 40L, "u2" to 10L, "u3" to 25L, "u4" to 10L)),
            10,
            TimeUnit.SECONDS
        )
        val byValueSnap = Tasks.await(scoresRef.orderByValue().get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("u2", "u4", "u3", "u1"), byValueSnap.children.map { it.key })

        // query-equal-to: 1-arg returns all matching ties; 2-arg (value, key) selects exact key tie
        val editorsSnap = Tasks.await(
            catalogRef.orderByChild("score").equalTo(20L).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-b", "item-d"), editorsSnap.children.map { it.key })

        val singleEditorSnap = Tasks.await(
            catalogRef.orderByChild("score").equalTo(20L, "item-d").get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-d"), singleEditorSnap.children.map { it.key })

        // query-range: inclusive startAt/endAt, cursor key tie-breaker, and exclusive startAfter/endBefore
        val inclusiveRangeSnap = Tasks.await(
            catalogRef.orderByChild("score").startAt(20L).endAt(30L).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-b", "item-d", "item-c"), inclusiveRangeSnap.children.map { it.key })

        val cursorRangeSnap = Tasks.await(
            catalogRef.orderByChild("score").startAt(20L, "item-d").endAt(30L).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-d", "item-c"), cursorRangeSnap.children.map { it.key })

        val exclusiveRangeSnap = Tasks.await(
            catalogRef.orderByChild("score").startAfter(20L).endBefore(50L).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-c"), exclusiveRangeSnap.children.map { it.key })

        // query-limit: limitToFirst and limitToLast, plus filtered child() visibility
        val firstTwoSnap = Tasks.await(
            catalogRef.orderByChild("score").limitToFirst(2).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-a", "item-b"), firstTwoSnap.children.map { it.key })
        assertTrue(firstTwoSnap.child("item-a").exists())
        assertFalse(firstTwoSnap.child("item-e").exists())

        val lastTwoSnap = Tasks.await(
            catalogRef.orderByChild("score").limitToLast(2).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("item-c", "item-e"), lastTwoSnap.children.map { it.key })
        assertTrue(lastTwoSnap.child("item-e").exists())
        assertFalse(lastTwoSnap.child("item-a").exists())

        // Client-side conflicting constraint validation
        assertThrows(IllegalArgumentException::class.java) {
            catalogRef.orderByChild("score").orderByKey()
        }
        assertThrows(IllegalArgumentException::class.java) {
            catalogRef.limitToFirst(2).limitToLast(2)
        }
        assertThrows(IllegalArgumentException::class.java) {
            catalogRef.limitToFirst(0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            catalogRef.orderByChild("score").startAt(10L).equalTo(20L)
        }
    }

    @Test
    fun `proves Section 8 optimistic transactions, abort, OnDisconnect over WebSocket close, and cancel on live host`() {
        val db = Firebase.database
        val txRoot = db.getReference("profiles/$uid/transactions")

        // Secondary client signed in as the same user over its own real WebSocket
        val contenderApp = FirebaseApp.initializeApp(
            "contender-app-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.contender")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        val contenderBridge = PyricBridgeClient(url = liveBridgeUrl)
        try {
            val contenderAuth = FirebaseAuth.getInstance(contenderApp, contenderBridge)
            Tasks.await(
                contenderAuth.signInWithEmailAndPassword(userEmail, USER_PASSWORD),
                10,
                TimeUnit.SECONDS
            )
            val contenderDb = FirebaseDatabase.getInstance(contenderApp)

            // tx-run: optimistic concurrency transaction with real contention forcing retry + nested MutableData mutation
            val walletRef = txRoot.child("wallet")
            Tasks.await(
                walletRef.setValue(mapOf("balance" to 100L, "txCount" to 0L)),
                10,
                TimeUnit.SECONDS
            )
            val contenderWalletRef = contenderDb.getReference("profiles/$uid/transactions/wallet")

            val attempts = AtomicInteger(0)
            data class TxCompletion(val error: DatabaseError?, val committed: Boolean, val snapshot: DataSnapshot?)
            val txFuture = CompletableFuture<TxCompletion>()

            walletRef.runTransaction(object : Transaction.Handler {
                override fun doTransaction(currentData: MutableData): Transaction.Result {
                    val attemptNum = attempts.incrementAndGet()
                    if (attemptNum == 1) {
                        // Inject a real competing write on the live host before our first commit attempt!
                        Tasks.await(
                            contenderWalletRef.setValue(mapOf("balance" to 250L, "txCount" to 1L)),
                            10,
                            TimeUnit.SECONDS
                        )
                    }
                    val currentBalance = currentData.child("balance").getValue<Long>() ?: 0L
                    val currentCount = currentData.child("txCount").getValue<Long>() ?: 0L
                    currentData.child("balance").value = currentBalance + 50L
                    currentData.child("txCount").value = currentCount + 1L
                    return Transaction.success(currentData)
                }

                override fun onComplete(
                    error: DatabaseError?,
                    committed: Boolean,
                    currentData: DataSnapshot?
                ) {
                    txFuture.complete(TxCompletion(error, committed, currentData))
                }
            })

            val txDone = txFuture.get(15, TimeUnit.SECONDS)
            assertNull(txDone.error)
            assertTrue(txDone.committed)
            assertTrue(attempts.get() >= 2, "Expected optimistic retry after competing write, attempts=${attempts.get()}")
            assertEquals(300L, txDone.snapshot?.child("balance")?.getValue<Long>())
            assertEquals(2L, txDone.snapshot?.child("txCount")?.getValue<Long>())
            assertEquals(
                300L,
                Tasks.await(walletRef.child("balance").get(), 10, TimeUnit.SECONDS).getValue<Long>()
            )

            // tx-abort: Transaction.abort() leaves server state untouched and reports committed == false
            val lockedRef = txRoot.child("lockedBalance")
            Tasks.await(lockedRef.setValue(500L), 10, TimeUnit.SECONDS)
            val abortFuture = CompletableFuture<TxCompletion>()
            lockedRef.runTransaction(object : Transaction.Handler {
                override fun doTransaction(currentData: MutableData): Transaction.Result {
                    currentData.value = 999L
                    return Transaction.abort()
                }

                override fun onComplete(
                    error: DatabaseError?,
                    committed: Boolean,
                    currentData: DataSnapshot?
                ) {
                    abortFuture.complete(TxCompletion(error, committed, currentData))
                }
            })
            val abortDone = abortFuture.get(10, TimeUnit.SECONDS)
            assertNull(abortDone.error)
            assertFalse(abortDone.committed)
            assertEquals(500L, abortDone.snapshot?.getValue<Long>())
            assertEquals(500L, Tasks.await(lockedRef.get(), 10, TimeUnit.SECONDS).getValue<Long>())

            // (a) OnDisconnect via goOffline() / goOnline() on primary client (setValue, removeValue, and cancel)
            val goOfflineRoot = db.getReference("profiles/$uid/presenceOfflineToggle")
            Tasks.await(goOfflineRoot.child("state").setValue("online"), 10, TimeUnit.SECONDS)
            Tasks.await(goOfflineRoot.child("tempToken").setValue("ephemeral"), 10, TimeUnit.SECONDS)
            Tasks.await(goOfflineRoot.child("retained").setValue("keep"), 10, TimeUnit.SECONDS)

            Tasks.await(goOfflineRoot.child("state").onDisconnect().setValue("away"), 10, TimeUnit.SECONDS)
            Tasks.await(goOfflineRoot.child("tempToken").onDisconnect().removeValue(), 10, TimeUnit.SECONDS)
            Tasks.await(goOfflineRoot.child("retained").onDisconnect().setValue("discarded"), 10, TimeUnit.SECONDS)
            Tasks.await(goOfflineRoot.child("retained").onDisconnect().cancel(), 10, TimeUnit.SECONDS)

            db.goOffline()
            awaitCondition("goOffline drained queued OnDisconnect setValue/removeValue") {
                val observerRef = contenderDb.getReference("profiles/$uid/presenceOfflineToggle")
                val st = Tasks.await(observerRef.child("state").get(), 10, TimeUnit.SECONDS)
                val tk = Tasks.await(observerRef.child("tempToken").get(), 10, TimeUnit.SECONDS)
                st.value == "away" && !tk.exists()
            }
            db.goOnline()
            assertEquals("away", Tasks.await(goOfflineRoot.child("state").get(), 10, TimeUnit.SECONDS).value)
            assertFalse(Tasks.await(goOfflineRoot.child("tempToken").get(), 10, TimeUnit.SECONDS).exists())
            assertEquals("keep", Tasks.await(goOfflineRoot.child("retained").get(), 10, TimeUnit.SECONDS).value)

            // (b) OnDisconnect over real OkHttp WebSocket close!
            val presenceRoot = contenderDb.getReference("profiles/$uid/presence")
            val statusNode = presenceRoot.child("state")
            val ephemeralLockNode = presenceRoot.child("ephemeralLock")
            val cancelledNode = presenceRoot.child("keepOnline")

            Tasks.await(statusNode.setValue("online"), 10, TimeUnit.SECONDS)
            Tasks.await(ephemeralLockNode.setValue("locked-by-session"), 10, TimeUnit.SECONDS)
            Tasks.await(cancelledNode.setValue("preserved"), 10, TimeUnit.SECONDS)

            Tasks.await(statusNode.onDisconnect().setValue("offline"), 10, TimeUnit.SECONDS)
            Tasks.await(ephemeralLockNode.onDisconnect().removeValue(), 10, TimeUnit.SECONDS)
            Tasks.await(cancelledNode.onDisconnect().setValue("should-not-run"), 10, TimeUnit.SECONDS)
            Tasks.await(cancelledNode.onDisconnect().cancel(), 10, TimeUnit.SECONDS)

            val observerPresenceRoot = db.getReference("profiles/$uid/presence")
            assertEquals("online", Tasks.await(observerPresenceRoot.child("state").get(), 10, TimeUnit.SECONDS).value)
            assertTrue(Tasks.await(observerPresenceRoot.child("ephemeralLock").get(), 10, TimeUnit.SECONDS).exists())
            assertEquals("preserved", Tasks.await(observerPresenceRoot.child("keepOnline").get(), 10, TimeUnit.SECONDS).value)

            // Close the contender's real WebSocket connection (code 1000) -> host drains queued OnDisconnect ops
            contenderBridge.terminate()

            awaitCondition("host executed OnDisconnect setValue('offline') and removeValue() on WebSocket close") {
                val stateSnap = Tasks.await(observerPresenceRoot.child("state").get(), 10, TimeUnit.SECONDS)
                val lockSnap = Tasks.await(observerPresenceRoot.child("ephemeralLock").get(), 10, TimeUnit.SECONDS)
                stateSnap.value == "offline" && !lockSnap.exists()
            }
            // Cancelled OnDisconnect operation must NOT have executed
            assertEquals(
                "preserved",
                Tasks.await(observerPresenceRoot.child("keepOnline").get(), 10, TimeUnit.SECONDS).value
            )
        } finally {
            contenderBridge.terminate()
        }
    }

    private fun awaitCondition(description: String, timeoutMs: Long = 5_000L, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(15)
        }
        assertTrue(condition(), "Timed out waiting for $description")
    }

    companion object {
        private const val PROJECT_ID = "demo-kotlin-live"
        private const val USER_PASSWORD = "RtdbLivePass!123"
    }
}
