package dev.pyric.bridge

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import dev.pyric.auth.AuthLens
import dev.pyric.database.DataSnapshot
import dev.pyric.database.DatabaseError
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ValueEventListener
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Deterministic gate-based regression tests for reconnect cancel races (D10),
 * RTDB goOnline/goOffline presence callback wire ordering (D1), RTDB auth-lens
 * collector cleanup on fast cancel and terminal errors, and Messaging service
 * handle cleanup on synchronous close during registration.
 */
class DeliveryContractEdgeCasesTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseMessaging.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "delivery-edge-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("edge-project")
                .setApiKey("edge-key")
                .setApplicationId("edge-app")
                .build()
        )
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseMessaging.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private suspend fun awaitState(state: BridgeConnectionState) {
        withTimeout(10_000) {
            client.connectionStates.first { it == state }
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun subPath(frame: Map<String, Any?>): String? {
        if (frame["type"] != "worker-sub") return null
        val target = (frame["sub"] as? Map<String, Any?>)?.get("target") as? Map<String, Any?>
        return target?.get("path") as? String
    }

    private suspend fun awaitDatabaseChildrenComplete(database: FirebaseDatabase) {
        val children = database.databaseScope.coroutineContext[Job]?.children?.toList().orEmpty()
        withTimeout(10_000) {
            for (child in children) {
                child.join()
            }
        }
    }

    @Test
    fun `D10 cancel before restoreAll reaches previously sent subscription sends no worker-sub or worker-unsub on epoch 2`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val secondSubId = AtomicReference<String?>(null)
        bridge.onFrame = { frame ->
            if (subPath(frame) == "items/b") {
                secondSubId.set(frame["subId"] as? String)
            }
        }
        val firstHandle = client.openSubscription(
            target = mapOf("__ref" to "doc", "path" to "items/a"),
            onValue = {},
            onWireError = {},
            onCloseError = {}
        )
        val secondHandle = client.openSubscription(
            target = mapOf("__ref" to "doc", "path" to "items/b"),
            onValue = {},
            onWireError = {},
            onCloseError = {}
        )
        val bSubId = secondSubId.get()
        assertTrue(!bSubId.isNullOrBlank(), "expected initial worker-sub for items/b")

        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        val epoch2Frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val cancelledBeforeB = AtomicBoolean(false)
        bridge.onFrame = { frame ->
            epoch2Frames.add(frame)
            if (subPath(frame) == "items/a" && cancelledBeforeB.compareAndSet(false, true)) {
                secondHandle.cancel()
            }
        }
        bridge.refuseConnections = false
        awaitState(BridgeConnectionState.ATTACHED)

        val bSubs = epoch2Frames.count { it["type"] == "worker-sub" && it["subId"] == bSubId }
        val bUnsubs = epoch2Frames.count { it["type"] == "worker-unsub" && it["subId"] == bSubId }
        assertEquals(0, bSubs, "cancelled subscription must not send worker-sub on epoch 2")
        assertEquals(0, bUnsubs, "subscription never sent on epoch 2 must not send spurious worker-unsub")
        firstHandle.cancel()
    }

    @Test
    fun `D10 cancel mid-sendSubFrame during restoreAll on epoch 2 sends worker-unsub exactly once`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val targetSubId = AtomicReference<String?>(null)
        bridge.onFrame = { frame ->
            if (subPath(frame) == "items/race") {
                targetSubId.set(frame["subId"] as? String)
            }
        }
        val handle = client.openSubscription(
            target = mapOf("__ref" to "doc", "path" to "items/race"),
            onValue = {},
            onWireError = {},
            onCloseError = {}
        )
        val subId = targetSubId.get()
        assertTrue(!subId.isNullOrBlank(), "expected initial worker-sub for items/race")

        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        val epoch2Frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val enteredEpoch2Send = CountDownLatch(1)
        val cancelCompleted = CountDownLatch(1)
        val intercepted = AtomicBoolean(false)
        val cancelThread = Thread {
            assertTrue(enteredEpoch2Send.await(10, TimeUnit.SECONDS))
            handle.cancel()
            cancelCompleted.countDown()
        }
        cancelThread.start()

        bridge.onFrame = { frame ->
            epoch2Frames.add(frame)
            if (frame["type"] == "worker-sub" && frame["subId"] == subId && intercepted.compareAndSet(false, true)) {
                enteredEpoch2Send.countDown()
                assertTrue(cancelCompleted.await(10, TimeUnit.SECONDS))
            }
        }
        bridge.refuseConnections = false
        awaitState(BridgeConnectionState.ATTACHED)
        cancelThread.join(10_000)

        val subs = epoch2Frames.count { it["type"] == "worker-sub" && it["subId"] == subId }
        val unsubs = epoch2Frames.count { it["type"] == "worker-unsub" && it["subId"] == subId }
        assertEquals(1, subs, "expected exactly one worker-sub on epoch 2")
        assertEquals(1, unsubs, "expected exactly one worker-unsub when cancelled mid-send on epoch 2")
    }

    @Test
    fun `D1 goOnline and goOffline dispatch wire ops before delivering info connected presence callbacks`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://edge-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val recordedOps = CopyOnWriteArrayList<String>()
        val initialTrue = CountDownLatch(1)
        val offlineOpSent = CountDownLatch(1)
        val onlineOpSent = CountDownLatch(1)
        val armPresence = AtomicBoolean(false)
        val sawFalseInCallback = AtomicBoolean(false)
        val sawTrueInCallback = AtomicBoolean(false)
        val callbackRanDuringGoOfflineSend = AtomicBoolean(false)
        val callbackRanDuringGoOnlineSend = AtomicBoolean(false)

        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val connected = snapshot.value as? Boolean ?: return
                if (!armPresence.get()) {
                    if (connected) initialTrue.countDown()
                    return
                }
                if (!connected) {
                    sawFalseInCallback.set(true)
                    database.getReference("presence/u1").setValue("offline")
                } else {
                    sawTrueInCallback.set(true)
                    database.getReference("presence/u1").onDisconnect().setValue("offline")
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        })
        assertTrue(initialTrue.await(10, TimeUnit.SECONDS), "expected initial .info/connected == true")

        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                @Suppress("UNCHECKED_CAST")
                val method = (frame["op"] as? Map<String, Any?>)?.get("method") as? String ?: ""
                recordedOps.add(method)
                when (method) {
                    "rtdb.goOffline" -> callbackRanDuringGoOfflineSend.set(sawFalseInCallback.get())
                    "rtdb.set" -> offlineOpSent.countDown()
                    "rtdb.goOnline" -> callbackRanDuringGoOnlineSend.set(sawTrueInCallback.get())
                    "rtdb.onDisconnectSet" -> onlineOpSent.countDown()
                }
            }
        }
        armPresence.set(true)

        database.goOffline()
        assertTrue(offlineOpSent.await(10, TimeUnit.SECONDS), "expected offline callback op")
        database.goOnline()
        assertTrue(onlineOpSent.await(10, TimeUnit.SECONDS), "expected onDisconnectSet from online callback")

        assertFalse(callbackRanDuringGoOfflineSend.get(), "offline callback must not run before rtdb.goOffline is sent")
        assertFalse(callbackRanDuringGoOnlineSend.get(), "online callback must not run before rtdb.goOnline is sent")
        assertEquals(
            listOf("rtdb.goOffline", "rtdb.set", "rtdb.goOnline", "rtdb.onDisconnectSet"),
            recordedOps.toList()
        )
    }

    @Test
    fun `RtdbSnapshotRegistration cancels lensMonitorJob when single-value listener finishes before init assigns job`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://edge-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val snapDelivered = CountDownLatch(1)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                val subId = frame["subId"]
                bridge.current.deliver(
                    mapOf(
                        "type" to "worker-snap",
                        "subId" to subId,
                        "value" to mapOf("exists" to true, "value" to "fast", "exportValue" to "fast")
                    )
                )
                assertTrue(snapDelivered.await(10, TimeUnit.SECONDS), "expected fast single-value callback")
            }
        }

        database.getReference("rooms/fast").addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                snapDelivered.countDown()
            }

            override fun onCancelled(error: DatabaseError) {}
        })

        awaitDatabaseChildrenComplete(database)

        val reopenCount = CopyOnWriteArrayList<String>()
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                reopenCount.add(frame["subId"].toString())
            }
        }
        database.setAuthLens(AuthLens.AsUser(uid = "user-2"))
        assertTrue(reopenCount.isEmpty(), "cancelled single-value listener must not reopen on auth lens change")
    }

    @Test
    fun `RtdbSnapshotRegistration cancels lensMonitorJob on wire error and on client disconnect`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://edge-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val firstSubId = AtomicReference<String?>(null)
        val secondSubId = AtomicReference<String?>(null)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                if (firstSubId.get() == null) {
                    firstSubId.set(frame["subId"] as? String)
                } else {
                    secondSubId.set(frame["subId"] as? String)
                }
            }
        }

        val wireCancelled = CountDownLatch(1)
        database.getReference("rooms/denied").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {
                wireCancelled.countDown()
            }
        })
        assertTrue(firstSubId.get() != null, "expected first RTDB worker-sub")
        bridge.current.deliver(
            mapOf(
                "type" to "worker-snap",
                "subId" to firstSubId.get(),
                "value" to mapOf("__error" to true, "code" to "PERMISSION_DENIED", "message" to "denied")
            )
        )
        assertTrue(wireCancelled.await(10, TimeUnit.SECONDS), "expected wire error callback")
        awaitDatabaseChildrenComplete(database)

        val closeCancelled = CountDownLatch(1)
        database.getReference("rooms/live").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {
                closeCancelled.countDown()
            }
        })
        assertTrue(secondSubId.get() != null, "expected second RTDB worker-sub")

        client.disconnect()
        assertTrue(closeCancelled.await(10, TimeUnit.SECONDS), "expected disconnect error callback")
        awaitDatabaseChildrenComplete(database)
    }

    @Test
    fun `FirebaseMessaging discards service handle when closed synchronously during registration`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val messaging = FirebaseMessaging.getInstance(app, client)
        val firstFgSub = AtomicBoolean(false)
        val subTargets = CopyOnWriteArrayList<String>()
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                @Suppress("UNCHECKED_CAST")
                val target = (frame["sub"] as? Map<String, Any?>)?.get("target") as? String
                if (target != null) subTargets.add(target)
                if (target == "messaging.foreground" && firstFgSub.compareAndSet(false, true)) {
                    throw RuntimeException("simulated immediate send failure")
                }
            }
        }

        val service1 = object : FirebaseMessagingService() {}
        val service2 = object : FirebaseMessagingService() {}
        messaging.registerService(service1)
        // A second registration must retry messaging.foreground rather than keeping a dead handle.
        messaging.registerService(service2)

        assertEquals(2, subTargets.count { it == "messaging.foreground" })
        assertEquals(1, subTargets.count { it == "messaging.background" })
        messaging.close()
    }

    @Test
    fun `Firestore terminate synchronously completes active document and query snapshot flows`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val firestore = FirebaseFirestore(client, app, "(default)")
        val docReady = CountDownLatch(1)
        val queryReady = CountDownLatch(1)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                val subId = frame["subId"]
                val path = subPath(frame)
                if (path == "users/alice") {
                    bridge.current.deliver(
                        mapOf(
                            "type" to "worker-snap",
                            "subId" to subId,
                            "value" to mapOf(
                                "id" to "alice",
                                "path" to "users/alice",
                                "exists" to true,
                                "data" to mapOf("name" to "Alice")
                            )
                        )
                    )
                } else {
                    bridge.current.deliver(
                        mapOf(
                            "type" to "worker-snap",
                            "subId" to subId,
                            "value" to mapOf("docs" to emptyList<Any>())
                        )
                    )
                }
            }
        }

        val docDone = CountDownLatch(1)
        val queryDone = CountDownLatch(1)
        val collectorScope = kotlinx.coroutines.CoroutineScope(
            kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.IO
        )
        collectorScope.launch {
            firestore.document("users/alice").snapshots().collect {
                docReady.countDown()
            }
            docDone.countDown()
        }
        collectorScope.launch {
            firestore.collection("users").snapshots().collect {
                queryReady.countDown()
            }
            queryDone.countDown()
        }
        try {
            assertTrue(docReady.await(10, TimeUnit.SECONDS), "expected initial doc snapshot")
            assertTrue(queryReady.await(10, TimeUnit.SECONDS), "expected initial query snapshot")
            com.google.android.gms.tasks.Tasks.await(firestore.terminate(), 10, TimeUnit.SECONDS)
            assertTrue(docDone.await(10, TimeUnit.SECONDS), "doc snapshots() flow must complete on terminate()")
            assertTrue(queryDone.await(10, TimeUnit.SECONDS), "query snapshots() flow must complete on terminate()")
        } finally {
            collectorScope.cancel()
        }
    }
}
