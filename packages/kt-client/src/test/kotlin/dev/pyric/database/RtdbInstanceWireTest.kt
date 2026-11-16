package dev.pyric.database

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import dev.pyric.database.internal.DatabaseInstanceResolver
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RtdbInstanceWireTest {
    private val sentFrames = CopyOnWriteArrayList<Map<String, Any?>>()
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp

    @BeforeEach
    fun setUp() {
        sentFrames.clear()
        FirebaseApp.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "rtdb-instance-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-proj")
                .setApiKey("key")
                .setApplicationId("app-id")
                .build()
        )
        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            sentFrames.add(frame)
            when (frame["type"] as? String) {
                "attach" -> transport.sendToClient(
                    """{"type":"attach-ack","protocol":1,"peerConnected":true}"""
                )
                "worker-op" -> {
                    val id = frame["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = frame["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    val value: Any? = when (method) {
                        "rtdb.get" -> mapOf(
                            "key" to "item",
                            "exists" to true,
                            "value" to 1,
                            "priority" to null,
                            "entries" to emptyList<Any>()
                        )
                        "rtdb.transactionCommit" -> mapOf(
                            "committed" to true,
                            "snapshot" to mapOf(
                                "key" to "item",
                                "exists" to true,
                                "value" to 2,
                                "priority" to null,
                                "entries" to emptyList<Any>()
                            )
                        )
                        else -> null
                    }
                    val reply = mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to value)
                    transport.sendToClient(JsonCodec.encodeToString(reply))
                }
                "worker-sub" -> {
                    val subId = frame["subId"] as String
                    val snap = mapOf(
                        "type" to "worker-snap",
                        "subId" to subId,
                        "value" to mapOf(
                            "key" to "item",
                            "exists" to true,
                            "value" to 1,
                            "priority" to null,
                            "entries" to emptyList<Any>()
                        )
                    )
                    transport.sendToClient(JsonCodec.encodeToString(snap))
                }
            }
        }
    }

    @AfterEach
    fun tearDown() {
        runBlocking { bridgeClient.disconnect() }
        FirebaseDatabase.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `DatabaseInstanceResolver extracts non-default names and omits defaults`() {
        assertEquals(
            "secondary-db",
            DatabaseInstanceResolver.resolveInstanceName("https://secondary-db.firebaseio.com", "demo-proj")
        )
        assertEquals(
            "analytics-eu",
            DatabaseInstanceResolver.resolveInstanceName(
                "https://analytics-eu.europe-west1.firebasedatabase.app/",
                "demo-proj"
            )
        )
        assertEquals(
            "tenant-b",
            DatabaseInstanceResolver.resolveInstanceName("http://localhost:9000/?ns=tenant-b", "demo-proj")
        )
        assertEquals(
            "regional-cache",
            DatabaseInstanceResolver.resolveInstanceName("regional-cache", "demo-proj")
        )

        assertNull(DatabaseInstanceResolver.resolveInstanceName(null, "demo-proj"))
        assertNull(DatabaseInstanceResolver.resolveInstanceName("", "demo-proj"))
        assertNull(DatabaseInstanceResolver.resolveInstanceName("default", "demo-proj"))
        assertNull(DatabaseInstanceResolver.resolveInstanceName(FirebaseDatabase.DEFAULT_DATABASE_URL, "demo-proj"))
        assertNull(DatabaseInstanceResolver.resolveInstanceName("http://localhost:9000/", "demo-proj"))
        assertNull(DatabaseInstanceResolver.resolveInstanceName("http://127.0.0.1:9000/", "demo-proj"))
        assertNull(
            DatabaseInstanceResolver.resolveInstanceName("https://demo-proj-default-rtdb.firebaseio.com", "demo-proj")
        )
        assertNull(
            DatabaseInstanceResolver.resolveInstanceName("https://demo-proj.firebaseio.com", "demo-proj")
        )
    }

    @Test
    fun `stamps wire instance on all rtdb ops and subscriptions for non-default databaseURL`() = runBlocking {
        val db = FirebaseDatabase(
            bridgeClient = bridgeClient,
            app = app,
            url = "https://analytics-eu.europe-west1.firebasedatabase.app"
        )
        val ref = db.getReference("items/item")

        Tasks.await(ref.get())
        Tasks.await(ref.setValue(mapOf("count" to 1)))
        Tasks.await(ref.setValue(mapOf("count" to 2), 10))
        Tasks.await(ref.setPriority(20))
        Tasks.await(ref.updateChildren(mapOf("count" to 3)))
        Tasks.await(ref.removeValue())

        val txnLatch = CountDownLatch(1)
        ref.runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                currentData.value = 2
                return Transaction.success(currentData)
            }

            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                txnLatch.countDown()
            }
        })
        assertTrue(txnLatch.await(5, TimeUnit.SECONDS))

        Tasks.await(ref.onDisconnect().setValue("gone"))
        Tasks.await(ref.onDisconnect().setValue("gone", 1))
        Tasks.await(ref.onDisconnect().updateChildren(mapOf("status" to "offline")))
        Tasks.await(ref.onDisconnect().removeValue())
        Tasks.await(ref.onDisconnect().cancel())

        db.goOffline()
        db.goOnline()
        withTimeout(5_000) {
            while (rtdbOps().none { it["method"] == "rtdb.goOnline" }) {
                delay(10)
            }
        }

        val snap = ref.snapshots().first()
        assertTrue(snap.exists())

        val ops = rtdbOps()
        assertTrue(ops.isNotEmpty())
        val expectedMethods = setOf(
            "rtdb.get",
            "rtdb.set",
            "rtdb.setWithPriority",
            "rtdb.setPriority",
            "rtdb.update",
            "rtdb.remove",
            "rtdb.transactionCommit",
            "rtdb.onDisconnectSet",
            "rtdb.onDisconnectUpdate",
            "rtdb.onDisconnectRemove",
            "rtdb.onDisconnectCancel",
            "rtdb.goOffline",
            "rtdb.goOnline"
        )
        assertTrue(ops.map { it["method"] as String }.toSet().containsAll(expectedMethods))
        for (op in ops) {
            assertEquals("analytics-eu", op["instance"], "Expected instance on ${op["method"]}")
        }

        val subs = rtdbSubTargets()
        assertEquals(1, subs.size)
        assertEquals("analytics-eu", subs.single()["instance"])
    }

    @Test
    fun `omits wire instance for default database URL`() = runBlocking {
        val db = FirebaseDatabase(
            bridgeClient = bridgeClient,
            app = app,
            url = FirebaseDatabase.DEFAULT_DATABASE_URL
        )
        val ref = db.getReference("items/item")

        Tasks.await(ref.get())
        Tasks.await(ref.setValue(mapOf("count" to 1)))
        ref.snapshots().first()

        val ops = rtdbOps()
        assertEquals(2, ops.size)
        for (op in ops) {
            assertFalse(op.containsKey("instance"))
        }

        val subs = rtdbSubTargets()
        assertEquals(1, subs.size)
        assertFalse(subs.single().containsKey("instance"))
    }

    private fun rtdbOps(): List<Map<String, Any?>> {
        return sentFrames
            .filter { it["type"] == "worker-op" }
            .mapNotNull {
                @Suppress("UNCHECKED_CAST")
                it["op"] as? Map<String, Any?>
            }
            .filter { (it["method"] as? String)?.startsWith("rtdb.") == true }
    }

    private fun rtdbSubTargets(): List<Map<String, Any?>> {
        return sentFrames
            .filter { it["type"] == "worker-sub" }
            .mapNotNull {
                @Suppress("UNCHECKED_CAST")
                val sub = it["sub"] as? Map<String, Any?>
                @Suppress("UNCHECKED_CAST")
                sub?.get("target") as? Map<String, Any?>
            }
            .filter { it["service"] == "rtdb" }
    }
}
