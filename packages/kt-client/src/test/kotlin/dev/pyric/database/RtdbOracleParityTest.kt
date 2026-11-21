package dev.pyric.database

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.MutableData
import com.google.firebase.database.ServerValue
import com.google.firebase.database.Transaction
import com.google.firebase.database.getValue
import dev.pyric.database.internal.RtdbInMemoryWorker
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
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
    @DisplayName("DataSnapshot.value returns java.lang.Long for integral numbers across scalars, maps, lists, sentinels, and priorities")
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
        assertEquals("java.lang.Long", rankedSnap.priority!!::class.java.name)
        assertEquals(7L, rankedSnap.priority)

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
    @DisplayName("MutableData.value normalizes integral numbers to java.lang.Long inside runTransaction")
    fun `MutableData value normalizes integral numbers to java lang Long inside runTransaction`() {
        val counterRef = database.getReference("tx/counter")
        Tasks.await(counterRef.setValue(20))

        val observedClasses = mutableListOf<String>()
        val completion = CompletableFuture<DataSnapshot?>()
        counterRef.runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                val raw = currentData.value
                if (raw != null) {
                    observedClasses.add(raw::class.java.name)
                }
                val current = (raw as? Long) ?: 0L
                currentData.value = (current + 5L).toInt()
                val afterAssign = currentData.value
                if (afterAssign != null) {
                    observedClasses.add(afterAssign::class.java.name)
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
        assertTrue(observedClasses.all { it == "java.lang.Long" })
    }
}
