package com.google.firebase.database

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.FakeReconnectBridge
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class RtdbPhase2ParityRegressionTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var database: FirebaseDatabase

    @BeforeEach
    fun setUp() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "rtdb-p2-app",
            FirebaseOptions.Builder()
                .setProjectId("rtdb-p2")
                .setApiKey("rtdb-p2-key")
                .setApplicationId("rtdb-p2-app-id")
                .build()
        )
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        database = FirebaseDatabase(client, app, "https://rtdb-p2-default-rtdb.firebaseio.com")
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private suspend fun awaitAttached() {
        client.connect()
        withTimeout(5000) {
            while (client.connectionState != BridgeConnectionState.ATTACHED) {
                kotlinx.coroutines.delay(10)
            }
        }
    }

    @Test
    fun `P2-K02 MutableData writeNested preserves List sibling elements`() {
        val md = MutableData(listOf("zero", "one", "two"))
        md.child("1").value = "ONE"
        @Suppress("UNCHECKED_CAST")
        val updated = md.value as Map<String, Any?>
        assertEquals("zero", updated["0"])
        assertEquals("ONE", updated["1"])
        assertEquals("two", updated["2"])
    }

    @Test
    fun `P2-K03d MutableData persists child priority and encodes wire priority`() {
        val md = MutableData(mapOf("a" to 1, "b" to mapOf("nested" to 2)))
        md.child("a").priority = 5.0
        md.child("b/nested").priority = "p-high"
        assertEquals(5.0, md.child("a").priority)
        assertEquals("p-high", md.child("b/nested").priority)
        assertEquals(1L, md.child("a").value)

        @Suppress("UNCHECKED_CAST")
        val encoded = md.encodeWireValue(null) as Map<String, Any?>
        assertEquals(mapOf(".value" to 1L, ".priority" to 5.0), encoded["a"])
        @Suppress("UNCHECKED_CAST")
        val bMap = encoded["b"] as Map<String, Any?>
        assertEquals(mapOf(".value" to 2L, ".priority" to "p-high"), bMap["nested"])
    }

    @Test
    fun `P2-K03 transaction maps handler exception to USER_CODE_EXCEPTION, encodes priority, pins txLens, and falls back when uncommitted`() = runBlocking {
        awaitAttached()
        database.setAuthLens(AuthLens.AsUser(uid = "alice"))

        val recordedUids = CopyOnWriteArrayList<String?>()
        val committedValue = AtomicReference<Any?>(null)
        var commitShouldSucceed = true

        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                val id = frame["id"] as String
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                val method = op["method"] as String
                @Suppress("UNCHECKED_CAST")
                val actAs = op["actAs"] as? Map<String, Any?>
                recordedUids.add(actAs?.get("uid") as? String)
                if (method == "rtdb.get") {
                    bridge.current.deliver(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to mapOf("key" to "node", "exists" to true, "value" to mapOf("a" to 1), "priority" to 1.0)
                        )
                    )
                } else if (method == "rtdb.transactionCommit") {
                    @Suppress("UNCHECKED_CAST")
                    val params = (op["params"] as? Map<String, Any?>) ?: op
                    committedValue.set(params["value"])
                    bridge.current.deliver(
                        mapOf(
                            "type" to "worker-res",
                            "id" to id,
                            "ok" to true,
                            "value" to if (commitShouldSucceed) {
                                mapOf("committed" to true, "retry" to false, "snapshot" to mapOf("key" to "node", "exists" to true, "value" to mapOf("a" to 2)))
                            } else {
                                mapOf("committed" to false, "retry" to false)
                            }
                        )
                    )
                }
            }
        }

        val errLatch = CountDownLatch(1)
        val caughtError = AtomicReference<DatabaseError?>(null)
        database.getReference("tx/node").runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                throw IllegalStateException("boom from handler")
            }
            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                caughtError.set(error)
                errLatch.countDown()
            }
        })
        assertTrue(errLatch.await(5, TimeUnit.SECONDS))
        assertEquals(DatabaseError.USER_CODE_EXCEPTION, caughtError.get()?.code)

        recordedUids.clear()
        val okLatch = CountDownLatch(1)
        database.getReference("tx/node").runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                database.setAuthLens(AuthLens.AsUser(uid = "bob"))
                currentData.child("a").value = 2
                currentData.child("a").priority = 9.0
                currentData.priority = 3.0
                return Transaction.success(currentData)
            }
            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                okLatch.countDown()
            }
        })
        assertTrue(okLatch.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("alice", "alice"), recordedUids.toList())
        @Suppress("UNCHECKED_CAST")
        val sentMap = committedValue.get() as Map<String, Any?>
        assertEquals(3.0, (sentMap[".priority"] as Number).toDouble())
        @Suppress("UNCHECKED_CAST")
        val sentA = sentMap["a"] as Map<String, Any?>
        assertEquals(2L, (sentA[".value"] as Number).toLong())
        assertEquals(9.0, (sentA[".priority"] as Number).toDouble())

        commitShouldSucceed = false
        val uncommitLatch = CountDownLatch(1)
        val uncommitCommitted = AtomicReference<Boolean?>(null)
        val uncommitValue = AtomicReference<Any?>(null)
        database.getReference("tx/node").runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                currentData.child("a").value = 999
                return Transaction.success(currentData)
            }
            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                uncommitCommitted.set(committed)
                uncommitValue.set(currentData?.value)
                uncommitLatch.countDown()
            }
        })
        assertTrue(uncommitLatch.await(5, TimeUnit.SECONDS))
        assertFalse(uncommitCommitted.get()!!)
        assertEquals(mapOf("a" to 1L), uncommitValue.get())
    }

    @Test
    fun `P2-K04 removeEventListener works across distinct getReference instances`() = runBlocking {
        awaitAttached()
        val unsubs = CopyOnWriteArrayList<String>()
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-unsub") {
                unsubs.add(frame["subId"].toString())
            }
        }
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {}
        }
        database.getReference("rooms/shared").addValueEventListener(listener)
        database.getReference("rooms/shared").removeEventListener(listener)
        withTimeout(3000) {
            while (unsubs.isEmpty()) {
                kotlinx.coroutines.delay(10)
            }
        }
        assertEquals(1, unsubs.size)
    }

    @Test
    fun `P2-K05 Query validates pre-existing bounds on orderByKey and rejects non-String or non-finite cursors`() {
        val ref = database.getReference("items")
        assertThrows(IllegalArgumentException::class.java) { ref.startAt(1).orderByKey() }
        assertThrows(IllegalArgumentException::class.java) { ref.startAt("a", "k").orderByKey() }
        assertThrows(IllegalArgumentException::class.java) { ref.orderByKey().startAt(1) }
        assertThrows(IllegalArgumentException::class.java) { ref.orderByKey().equalTo(true) }
        assertThrows(IllegalArgumentException::class.java) { ref.startAt(Double.NaN) }
        assertThrows(IllegalArgumentException::class.java) { ref.endAt(Double.POSITIVE_INFINITY) }
        assertThrows(IllegalArgumentException::class.java) { ref.startAt(mapOf("x" to 1)) }
    }
}
