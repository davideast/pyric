package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.ChildEvent
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.childEvents
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class RtdbOracleParityLiveHostConformanceTest {
    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var app: FirebaseApp

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping RTDB Android 35.2.0 oracle parity live-host conformance test"
        )
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        app = FirebaseApp.initializeApp(
            "rtdb-oracle-parity-live-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.rtdb.oracle.parity")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        bridgeClient = PyricBridgeClient(url = envUrl)
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
    @DisplayName("rtdb-kotlin#snap-priority & rtdb-kotlin#listen-child-changed: live-host parity with Android BoM 35.2.0")
    fun `proves Double numeric priority revival and Moved-before-Changed ChildEvent ordering on live host`() {
        val client = requireNotNull(bridgeClient)
        val auth = FirebaseAuth.getInstance(app, client)
        val database = FirebaseDatabase.getInstance(app, client)

        val user = requireNotNull(Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user)
        val uid = user.uid

        // 1. Numeric priorities revive as java.lang.Double while integral values stay java.lang.Long
        val prioRef = database.getReference("profiles/$uid/priorities")
        Tasks.await(prioRef.child("p_second").setValue("second"), 10, TimeUnit.SECONDS)
        Tasks.await(prioRef.child("p_second").setPriority(20), 10, TimeUnit.SECONDS)
        Tasks.await(prioRef.child("p_first").setValue("first", 5), 10, TimeUnit.SECONDS)
        Tasks.await(prioRef.child("p_third").setValue("third", "zeta"), 10, TimeUnit.SECONDS)
        Tasks.await(prioRef.child("p_int_val").setValue(42, 9), 10, TimeUnit.SECONDS)

        val pSecondSnap = Tasks.await(prioRef.child("p_second").get(), 10, TimeUnit.SECONDS)
        assertNotNull(pSecondSnap.priority)
        assertEquals("java.lang.Double", pSecondSnap.priority!!::class.java.name)
        assertEquals(20.0, pSecondSnap.priority)

        val pFirstSnap = Tasks.await(prioRef.child("p_first").get(), 10, TimeUnit.SECONDS)
        assertNotNull(pFirstSnap.priority)
        assertEquals("java.lang.Double", pFirstSnap.priority!!::class.java.name)
        assertEquals(5.0, pFirstSnap.priority)

        val pThirdSnap = Tasks.await(prioRef.child("p_third").get(), 10, TimeUnit.SECONDS)
        assertEquals("java.lang.String", pThirdSnap.priority!!::class.java.name)
        assertEquals("zeta", pThirdSnap.priority)

        val pIntValSnap = Tasks.await(prioRef.child("p_int_val").get(), 10, TimeUnit.SECONDS)
        assertEquals("java.lang.Long", pIntValSnap.value!!::class.java.name)
        assertEquals(42L, pIntValSnap.value)
        assertEquals("java.lang.Double", pIntValSnap.priority!!::class.java.name)
        assertEquals(9.0, pIntValSnap.priority)

        @Suppress("UNCHECKED_CAST")
        val exportedLeaf = pIntValSnap.getValue(true) as Map<String, Any?>
        assertEquals("java.lang.Long", exportedLeaf[".value"]!!::class.java.name)
        assertEquals(42L, exportedLeaf[".value"])
        assertEquals("java.lang.Double", exportedLeaf[".priority"]!!::class.java.name)
        assertEquals(9.0, exportedLeaf[".priority"])

        val parentSnap = Tasks.await(prioRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("java.lang.Double", parentSnap.child("p_second").priority!!::class.java.name)
        assertEquals(20.0, parentSnap.child("p_second").priority)

        Tasks.await(prioRef.child("p_second").setPriority(null), 10, TimeUnit.SECONDS)
        assertNull(Tasks.await(prioRef.child("p_second").get(), 10, TimeUnit.SECONDS).priority)

        // 2. ChildEventListener + childEvents Flow emit Moved BEFORE Changed and skip unchanged peers
        val scoresRef = database.getReference("profiles/$uid/scores")
        Tasks.await(scoresRef.setValue(mapOf("a" to 1L, "b" to 2L)), 10, TimeUnit.SECONDS)

        val listenerEvents = CopyOnWriteArrayList<String>()
        val flowEvents = CopyOnWriteArrayList<String>()
        val streamScope = CoroutineScope(Dispatchers.IO)
        val orderedScores = scoresRef.orderByValue()

        val flowJob = streamScope.launch {
            orderedScores.childEvents.collect { ev ->
                when (ev) {
                    is ChildEvent.Added -> flowEvents.add("added:${ev.snapshot.key}:prev=${ev.previousChildName}")
                    is ChildEvent.Moved -> flowEvents.add("moved:${ev.snapshot.key}:prev=${ev.previousChildName}")
                    is ChildEvent.Changed -> flowEvents.add("changed:${ev.snapshot.key}:${ev.snapshot.value}")
                    is ChildEvent.Removed -> flowEvents.add("removed:${ev.snapshot.key}")
                }
            }
        }

        val childListener = orderedScores.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                listenerEvents.add("added:${snapshot.key}:prev=$previousChildName")
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                listenerEvents.add("changed:${snapshot.key}:${snapshot.value}")
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {
                listenerEvents.add("removed:${snapshot.key}")
            }

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                listenerEvents.add("moved:${snapshot.key}:prev=$previousChildName")
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        try {
            awaitLive("initial Added for scores a, b") {
                listenerEvents.size >= 2 && flowEvents.size >= 2
            }
            assertEquals(listOf("added:a:prev=null", "added:b:prev=a"), listenerEvents.toList())

            Tasks.await(scoresRef.child("c").setValue(3L), 10, TimeUnit.SECONDS)
            awaitLive("Added c") {
                listenerEvents.size >= 3 && flowEvents.size >= 3
            }
            assertEquals("added:c:prev=b", listenerEvents[2])

            val beforeReorder = listenerEvents.size
            val flowBeforeReorder = flowEvents.size
            Tasks.await(scoresRef.child("a").setValue(10L), 10, TimeUnit.SECONDS)
            awaitLive("Moved then Changed for a") {
                listenerEvents.size >= beforeReorder + 2 && flowEvents.size >= flowBeforeReorder + 2
            }

            assertEquals(
                listOf("moved:a:prev=c", "changed:a:10"),
                listenerEvents.subList(beforeReorder, listenerEvents.size).toList()
            )
            assertEquals(
                listOf("moved:a:prev=c", "changed:a:10"),
                flowEvents.subList(flowBeforeReorder, flowEvents.size).toList()
            )
        } finally {
            orderedScores.removeEventListener(childListener)
            flowJob.cancel()
            streamScope.cancel()
        }
    }

    private fun awaitLive(description: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (System.nanoTime() < deadline) {
            if (condition()) {
                return
            }
            Thread.sleep(15)
        }
        throw AssertionError("Timed out waiting for $description")
    }

    companion object {
        private const val PROJECT_ID = "demo-kotlin-live"
    }
}
