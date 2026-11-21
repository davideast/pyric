package dev.pyric.database

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.database.ChildEvent
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.MutableData
import com.google.firebase.database.ServerValue
import com.google.firebase.database.Transaction
import com.google.firebase.database.childEvents
import com.google.firebase.database.getValue
import dev.pyric.database.internal.RtdbInMemoryWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

class RtdbOracleParityTest {
    data class CounterRecord(
        var label: String = "",
        var count: Long = 0L,
        var step: Int = 0,
        var ratio: Double = 0.0
    )

    private lateinit var worker: RtdbInMemoryWorker
    private lateinit var app: FirebaseApp
    private lateinit var database: FirebaseDatabase

    @BeforeEach
    fun setUp() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        worker = RtdbInMemoryWorker()
        app = FirebaseApp.initializeApp(
            "rtdb-oracle-parity-app",
            FirebaseOptions.Builder()
                .setProjectId("rtdb-oracle-parity")
                .setApiKey("rtdb-key")
                .setApplicationId("rtdb-app-id")
                .build()
        )
        database = FirebaseDatabase.getInstance(
            app = app,
            bridgeClient = worker.createBridgeClient(),
            url = "https://rtdb-oracle-parity-default-rtdb.firebaseio.com"
        )
    }

    @AfterEach
    fun tearDown() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("DataSnapshot.value returns java.lang.Long for integral numbers while priority returns java.lang.Double")
    fun `DataSnapshot value returns java lang Long for integral numbers`() {
        val ref = database.getReference("metrics/counter_doc")
        Tasks.await(
            ref.setValue(
                mapOf(
                    "label" to "alpha",
                    "count" to 10,
                    "buckets" to listOf(1, 2, 3),
                    "ratio" to 2.5
                )
            )
        )
        Tasks.await(
            ref.updateChildren(
                mapOf(
                    "count" to ServerValue.increment(5L),
                    "extra" to "kept"
                )
            )
        )
        Tasks.await(ref.child("ranked").setValue("gold", 7))

        val snap = Tasks.await(ref.get())
        val countVal = snap.child("count").value
        assertNotNull(countVal)
        assertEquals("java.lang.Long", countVal!!::class.java.name)
        assertEquals(15L, countVal)
        assertEquals(15L, snap.child("count").getValue(false))
        assertEquals(15L, snap.child("count").getValue(Long::class.java))
        assertEquals(15, snap.child("count").getValue(Int::class.java))
        assertEquals(15L, snap.child("count").getValue<Long>())
        assertEquals(15, snap.child("count").getValue<Int>())

        @Suppress("UNCHECKED_CAST")
        val rootMap = snap.value as Map<String, Any?>
        assertEquals("java.lang.Long", rootMap["count"]!!::class.java.name)
        assertEquals(15L, rootMap["count"])

        @Suppress("UNCHECKED_CAST")
        val buckets = rootMap["buckets"] as List<Any?>
        assertEquals(listOf(1L, 2L, 3L), buckets)
        assertTrue(buckets.all { it != null && it::class.java.name == "java.lang.Long" })

        val ratioVal = snap.child("ratio").value
        assertNotNull(ratioVal)
        assertEquals("java.lang.Double", ratioVal!!::class.java.name)
        assertEquals(2.5, ratioVal)

        val rankedSnap = Tasks.await(ref.child("ranked").get())
        assertEquals("java.lang.Double", rankedSnap.priority!!::class.java.name)
        assertEquals(7.0, rankedSnap.priority)

        val beanRef = database.getReference("metrics/bean")
        Tasks.await(beanRef.setValue(mapOf("label" to "beta", "count" to 42, "step" to 3, "ratio" to 1.25)))
        val bean = Tasks.await(beanRef.get()).getValue(CounterRecord::class.java)
        assertNotNull(bean)
        assertEquals("beta", bean!!.label)
        assertEquals(42L, bean.count)
        assertEquals(3, bean.step)
        assertEquals(1.25, bean.ratio)
    }

    @Test
    @DisplayName("rtdb-kotlin#snap-priority: numeric priorities revive as java.lang.Double across DataSnapshot, export format, and MutableData")
    fun `numeric priorities revive as java lang Double across DataSnapshot export format and MutableData`() {
        val prioRef = database.getReference("priorities")
        Tasks.await(prioRef.child("p_second").setValue("second"))
        Tasks.await(prioRef.child("p_second").setPriority(20))
        Tasks.await(prioRef.child("p_first").setValue("first", 5))
        Tasks.await(prioRef.child("p_third").setValue("third", "zeta"))
        Tasks.await(prioRef.child("p_int_val").setValue(42, 9))

        val pSecondSnap = Tasks.await(prioRef.child("p_second").get())
        assertEquals("java.lang.Double", pSecondSnap.priority!!::class.java.name)
        assertEquals(20.0, pSecondSnap.priority)

        val pFirstSnap = Tasks.await(prioRef.child("p_first").get())
        assertEquals("java.lang.Double", pFirstSnap.priority!!::class.java.name)
        assertEquals(5.0, pFirstSnap.priority)

        val pThirdSnap = Tasks.await(prioRef.child("p_third").get())
        assertEquals("java.lang.String", pThirdSnap.priority!!::class.java.name)
        assertEquals("zeta", pThirdSnap.priority)

        val pIntValSnap = Tasks.await(prioRef.child("p_int_val").get())
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

        val parentSnap = Tasks.await(prioRef.get())
        val childViaPath = parentSnap.child("p_second")
        assertEquals("java.lang.Double", childViaPath.priority!!::class.java.name)
        assertEquals(20.0, childViaPath.priority)

        val childrenByKey = parentSnap.children.associateBy { it.key }
        assertEquals("java.lang.Double", childrenByKey["p_first"]!!.priority!!::class.java.name)
        assertEquals(5.0, childrenByKey["p_first"]!!.priority)
        assertEquals("java.lang.String", childrenByKey["p_third"]!!.priority!!::class.java.name)
        assertEquals("zeta", childrenByKey["p_third"]!!.priority)

        Tasks.await(prioRef.child("p_second").setPriority(null))
        assertNull(Tasks.await(prioRef.child("p_second").get()).priority)

        val mutable = MutableData(initialValue = 12, initialPriority = 20)
        assertEquals("java.lang.Long", mutable.value!!::class.java.name)
        assertEquals(12L, mutable.value)
        assertEquals("java.lang.Double", mutable.priority!!::class.java.name)
        assertEquals(20.0, mutable.priority)
        mutable.priority = 35
        assertEquals("java.lang.Double", mutable.priority!!::class.java.name)
        assertEquals(35.0, mutable.priority)
        mutable.priority = "omega"
        assertEquals("omega", mutable.priority)
        mutable.priority = null
        assertNull(mutable.priority)
    }

    @Test
    @DisplayName("MutableData.value normalizes integral numbers to java.lang.Long inside runTransaction")
    fun `MutableData value normalizes integral numbers to java lang Long inside runTransaction`() {
        val counterRef = database.getReference("tx/counter")
        Tasks.await(counterRef.setValue(20, 4))

        val observedValueClasses = mutableListOf<String>()
        val observedPriorityClasses = mutableListOf<String>()
        val completion = CompletableFuture<DataSnapshot?>()
        counterRef.runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                val raw = currentData.value
                if (raw != null) {
                    observedValueClasses.add(raw::class.java.name)
                }
                val prio = currentData.priority
                if (prio != null) {
                    observedPriorityClasses.add(prio::class.java.name)
                }
                val current = (raw as? Long) ?: 0L
                currentData.value = (current + 5L).toInt()
                val afterAssign = currentData.value
                if (afterAssign != null) {
                    observedValueClasses.add(afterAssign::class.java.name)
                }
                return Transaction.success(currentData)
            }

            override fun onComplete(
                error: DatabaseError?,
                committed: Boolean,
                currentData: DataSnapshot?
            ) {
                assertNull(error)
                assertTrue(committed)
                completion.complete(currentData)
            }
        })

        val finalSnap = completion.get(5, TimeUnit.SECONDS)
        assertNotNull(finalSnap)
        assertEquals("java.lang.Long", finalSnap!!.value!!::class.java.name)
        assertEquals(25L, finalSnap.value)
        assertTrue(observedValueClasses.all { it == "java.lang.Long" })
        assertTrue(observedPriorityClasses.all { it == "java.lang.Double" })
    }

    @Test
    @DisplayName("rtdb-kotlin#listen-child-changed: onChildMoved fires before onChildChanged and never fires for unmodified bystander peers")
    fun `onChildMoved fires before onChildChanged and never fires for unmodified bystander peers`() {
        val watchRef = database.getReference("watched_scores")
        Tasks.await(watchRef.setValue(mapOf("a" to 1, "b" to 2)))

        val events = CopyOnWriteArrayList<String>()
        val flowEvents = CopyOnWriteArrayList<String>()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val orderedQuery = watchRef.orderByValue()

        val flowJob = scope.launch {
            orderedQuery.childEvents.collect { ev ->
                when (ev) {
                    is ChildEvent.Added -> flowEvents.add("added:${ev.snapshot.key}:prev=${ev.previousChildName}")
                    is ChildEvent.Moved -> flowEvents.add("moved:${ev.snapshot.key}:prev=${ev.previousChildName}")
                    is ChildEvent.Changed -> flowEvents.add("changed:${ev.snapshot.key}:${ev.snapshot.value}")
                    is ChildEvent.Removed -> flowEvents.add("removed:${ev.snapshot.key}")
                }
            }
        }

        val listener = orderedQuery.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                events.add("added:${snapshot.key}:prev=$previousChildName")
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                events.add("changed:${snapshot.key}:${snapshot.value}")
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {
                events.add("removed:${snapshot.key}")
            }

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                events.add("moved:${snapshot.key}:prev=$previousChildName")
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        try {
            awaitEvents("initial Added a, b") { events.size >= 2 && flowEvents.size >= 2 }
            assertEquals(listOf("added:a:prev=null", "added:b:prev=a"), events.toList())

            Tasks.await(watchRef.child("c").setValue(3))
            awaitEvents("Added c") { events.size >= 3 && flowEvents.size >= 3 }
            assertEquals("added:c:prev=b", events[2])

            val beforeReorder = events.size
            val flowBeforeReorder = flowEvents.size
            Tasks.await(watchRef.child("a").setValue(10))
            awaitEvents("Moved then Changed for a") {
                events.size >= beforeReorder + 2 && flowEvents.size >= flowBeforeReorder + 2
            }

            val reorderSlice = events.subList(beforeReorder, events.size).toList()
            val flowReorderSlice = flowEvents.subList(flowBeforeReorder, flowEvents.size).toList()
            assertEquals(listOf("moved:a:prev=c", "changed:a:10"), reorderSlice)
            assertEquals(listOf("moved:a:prev=c", "changed:a:10"), flowReorderSlice)

            val beforeRemove = events.size
            Tasks.await(watchRef.child("b").removeValue())
            awaitEvents("Removed b") { events.size >= beforeRemove + 1 }
            assertEquals(listOf("removed:b"), events.subList(beforeRemove, events.size).toList())
        } finally {
            orderedQuery.removeEventListener(listener)
            flowJob.cancel()
            scope.cancel()
        }
    }

    @Test
    @DisplayName("orderByChild and orderByKey emit ChildEvent.Moved only when indexed sort field changes")
    fun `orderByChild and orderByKey emit Moved only when indexed sort field changes`() {
        val catalogRef = database.getReference("catalog")
        Tasks.await(
            catalogRef.setValue(
                mapOf(
                    "item-a" to mapOf("score" to 10, "label" to "Alpha"),
                    "item-b" to mapOf("score" to 30, "label" to "Beta")
                )
            )
        )

        val childOrdered = catalogRef.orderByChild("score")
        val keyOrdered = catalogRef.orderByKey()
        val childOrderedEvents = CopyOnWriteArrayList<String>()
        val keyOrderedEvents = CopyOnWriteArrayList<String>()

        val childListener = childOrdered.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                childOrderedEvents.add("added:${snapshot.key}:prev=$previousChildName")
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                val score = snapshot.child("score").value
                val label = snapshot.child("label").value
                childOrderedEvents.add("changed:${snapshot.key}:$score:$label:prev=$previousChildName")
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {}

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                childOrderedEvents.add("moved:${snapshot.key}:prev=$previousChildName")
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        val keyListener = keyOrdered.addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                keyOrderedEvents.add("added:${snapshot.key}:prev=$previousChildName")
            }

            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                keyOrderedEvents.add("changed:${snapshot.key}:prev=$previousChildName")
            }

            override fun onChildRemoved(snapshot: DataSnapshot) {}

            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                keyOrderedEvents.add("moved:${snapshot.key}:prev=$previousChildName")
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        try {
            awaitEvents("initial catalog Added") {
                childOrderedEvents.size >= 2 && keyOrderedEvents.size >= 2
            }

            val beforeLabelUpdate = childOrderedEvents.size
            Tasks.await(catalogRef.child("item-a/label").setValue("AlphaRenamed"))
            awaitEvents("non-indexed label update") { childOrderedEvents.size >= beforeLabelUpdate + 1 }
            assertEquals(
                listOf("changed:item-a:10:AlphaRenamed:prev=null"),
                childOrderedEvents.subList(beforeLabelUpdate, childOrderedEvents.size).toList()
            )

            val beforeScoreUpdate = childOrderedEvents.size
            val beforeKeyUpdate = keyOrderedEvents.size
            Tasks.await(catalogRef.child("item-a/score").setValue(50))
            awaitEvents("indexed score update") {
                childOrderedEvents.size >= beforeScoreUpdate + 2 &&
                    keyOrderedEvents.size >= beforeKeyUpdate + 1
            }
            assertEquals(
                listOf("moved:item-a:prev=item-b", "changed:item-a:50:AlphaRenamed:prev=item-b"),
                childOrderedEvents.subList(beforeScoreUpdate, childOrderedEvents.size).toList()
            )
            assertEquals(
                listOf("changed:item-a:prev=null"),
                keyOrderedEvents.subList(beforeKeyUpdate, keyOrderedEvents.size).toList()
            )
        } finally {
            childOrdered.removeEventListener(childListener)
            keyOrdered.removeEventListener(keyListener)
        }
    }

    private fun awaitEvents(description: String, condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
            if (condition()) {
                return
            }
            Thread.sleep(10)
        }
        throw AssertionError("Timed out waiting for $description")
    }
}
