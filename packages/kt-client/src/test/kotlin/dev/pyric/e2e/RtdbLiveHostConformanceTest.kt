package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseException
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue
import com.google.firebase.database.ValueEventListener
import com.google.firebase.database.database
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

/**
 * Live-host conformance suite for rtdb-kotlin Sections 1-4 against a running Pyric Node host:
 * 1. Database Instance & Connection (instance-default, instance-url, ref-root, ref-path, connection-toggle, info-connected)
 * 2. DatabaseReference Navigation & Properties (ref-child, ref-parent, ref-root-prop, ref-key, ref-path-prop, ref-push, ref-push-key-ordering)
 * 3. Write Operations (write-set, write-set-null, write-set-priority, write-set-with-priority, write-update, write-remove)
 * 4. ServerValue Sentinels (sentinel-timestamp, sentinel-increment)
 */
class RtdbLiveHostConformanceTest {
    private var bridgeClient: PyricBridgeClient? = null
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
        val client = PyricBridgeClient(url = envUrl)
        bridgeClient = client
        val auth = FirebaseAuth.getInstance(defaultApp, client)
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(
                "rtdb-slice1-${System.nanoTime()}@example.com",
                "RtdbLivePass!123"
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
    }
}
