package dev.pyric.bridge

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import dev.pyric.auth.AuthLens
import dev.pyric.database.ChildEventListener
import dev.pyric.database.DataSnapshot
import dev.pyric.database.DatabaseError
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ValueEventListener
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Deterministic gate-based tests covering ADR-0019 Kotlin delivery contract
 * findings K9 (D5 restore order), K12 (D6 .info close), K14 (D7 synchronous
 * registration), K15 (D7/D8/D9 .info non-conflation and getter consistency),
 * K16 (D7/D8 unbounded buffers), K17 (D8 cross-subscription order), and
 * finishAttach ATTACHED publication after hold-queue release.
 */
class DeliveryContractRegistrationAndOrderTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "delivery-contract-pr2-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("contract-project")
                .setApiKey("contract-key")
                .setApplicationId("contract-app")
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
        scope.cancel()
        runBlocking { client.disconnect() }
        bridge.shutdown()
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

    private fun deliverSnap(subId: Any?, value: Any?) {
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to value))
    }

    @Suppress("UNCHECKED_CAST")
    private fun subPath(frame: Map<String, Any?>): String? {
        if (frame["type"] != "worker-sub") return null
        val target = (frame["sub"] as? Map<String, Any?>)?.get("target") as? Map<String, Any?>
        return target?.get("path") as? String
    }

    @Test
    fun `K9 D5 restored subscriptions follow creation order ahead of subscriptions opened while interrupted or restoring`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val initialSubsSent = CountDownLatch(10)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") initialSubsSent.countDown()
        }
        repeat(10) { i ->
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    client.subscribe(mapOf("__ref" to "doc", "path" to "old/$i")).collect {}
                } catch (_: Throwable) {}
            }
        }
        assertTrue(initialSubsSent.await(10, TimeUnit.SECONDS), "all 10 initial subs should be sent")

        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        repeat(3) { i ->
            scope.launch(start = CoroutineStart.UNDISPATCHED) {
                try {
                    client.subscribe(mapOf("__ref" to "doc", "path" to "new/$i")).collect {}
                } catch (_: Throwable) {}
            }
        }

        val reattachedOrder = CopyOnWriteArrayList<String>()
        val reattachedDone = CountDownLatch(14)
        val openedDuringRestore = AtomicBoolean(false)
        bridge.onFrame = { frame ->
            val path = subPath(frame)
            if (path != null) {
                reattachedOrder.add(path)
                if (path == "old/0" && openedDuringRestore.compareAndSet(false, true)) {
                    scope.launch(start = CoroutineStart.UNDISPATCHED) {
                        try {
                            client.subscribe(mapOf("__ref" to "doc", "path" to "during/0")).collect {}
                        } catch (_: Throwable) {}
                    }
                }
                reattachedDone.countDown()
            }
        }
        bridge.refuseConnections = false
        assertTrue(reattachedDone.await(10, TimeUnit.SECONDS), "expected 14 re-attached worker-sub frames, got $reattachedOrder")

        val expected = (0 until 10).map { "old/$it" } + (0 until 3).map { "new/$it" } + listOf("during/0")
        assertEquals(expected, reattachedOrder.toList())
    }

    @Test
    fun `K12 D6 info connected listener ends once at disconnect and receives nothing after disconnect returns`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val seen = CopyOnWriteArrayList<Any?>()
        val initialTrue = CountDownLatch(1)
        val cancelledLatch = CountDownLatch(1)
        val cancelledCount = AtomicInteger(0)
        val closedFlag = AtomicBoolean(false)
        val afterClose = AtomicInteger(0)

        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (closedFlag.get()) afterClose.incrementAndGet()
                seen.add(snapshot.value)
                if (snapshot.value == true) initialTrue.countDown()
            }

            override fun onCancelled(error: DatabaseError) {
                cancelledCount.incrementAndGet()
                cancelledLatch.countDown()
            }
        })
        assertTrue(initialTrue.await(10, TimeUnit.SECONDS), "expected initial .info/connected == true")

        client.disconnect()
        closedFlag.set(true)

        assertTrue(cancelledLatch.await(10, TimeUnit.SECONDS), "expected .info/connected onCancelled after disconnect")
        assertEquals(0, afterClose.get(), "no value may reach .info/connected after disconnect returns; seen=$seen")
        assertEquals(listOf<Any?>(true), seen.toList())
        assertEquals(1, cancelledCount.get())

        // Registering after disconnect ends once with onCancelled and emits no value.
        val lateCancelled = CountDownLatch(1)
        val lateValues = AtomicInteger(0)
        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { lateValues.incrementAndGet() }
            override fun onCancelled(error: DatabaseError) { lateCancelled.countDown() }
        })
        assertTrue(lateCancelled.await(10, TimeUnit.SECONDS))
        assertEquals(0, lateValues.get())
    }

    @Test
    fun `K12 D6 info connected ends once on policy close 1008 without emitting false`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)
        val seen = CopyOnWriteArrayList<Any?>()
        val initialTrue = CountDownLatch(1)
        val cancelled = CountDownLatch(1)
        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                seen.add(snapshot.value)
                if (snapshot.value == true) initialTrue.countDown()
            }
            override fun onCancelled(error: DatabaseError) { cancelled.countDown() }
        })
        assertTrue(initialTrue.await(10, TimeUnit.SECONDS))
        bridge.current.drop(code = 1008)
        assertTrue(cancelled.await(10, TimeUnit.SECONDS))
        assertEquals(listOf<Any?>(true), seen.toList())
    }

    @Test
    fun `K15 D7 D8 info connected reports drop and re-attach without conflating while callback is busy`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val seen = CopyOnWriteArrayList<Any?>()
        val enteredFirst = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val fourSeen = CountDownLatch(4)
        val secondAttachAcked = CountDownLatch(1)

        bridge.onFrame = { frame ->
            if (frame["type"] == "attach" && bridge.ofType("attach").size == 2) {
                secondAttachAcked.countDown()
            }
        }

        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                seen.add(snapshot.value)
                fourSeen.countDown()
                if (seen.size == 1) {
                    enteredFirst.countDown()
                    releaseFirst.await(10, TimeUnit.SECONDS)
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        })
        assertTrue(enteredFirst.await(10, TimeUnit.SECONDS), "listener should enter first callback")

        bridge.current.drop()
        assertTrue(secondAttachAcked.await(10, TimeUnit.SECONDS), "second attach should start")
        awaitState(BridgeConnectionState.ATTACHED)
        releaseFirst.countDown()

        bridge.refuseConnections = true
        bridge.current.drop()
        assertTrue(fourSeen.await(10, TimeUnit.SECONDS), "expected 4 transitions, got $seen")
        assertEquals(listOf<Any?>(true, false, true, false), seen.toList())
    }

    @Test
    fun `K15 D9 info connected getter never runs ahead of a queued goOffline transition`() = runBlocking {
        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")
        awaitState(BridgeConnectionState.ATTACHED)

        val seen = CopyOnWriteArrayList<Any?>()
        val afterGetter = CopyOnWriteArrayList<Any?>()
        val initialTrue = CountDownLatch(1)
        val getterDone = AtomicBoolean(false)
        val sentinelOffline = CountDownLatch(1)

        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                seen.add(snapshot.value)
                if (getterDone.get()) {
                    afterGetter.add(snapshot.value)
                    if (snapshot.value == false) sentinelOffline.countDown()
                }
                if (seen.size == 1 && snapshot.value == true) initialTrue.countDown()
            }

            override fun onCancelled(error: DatabaseError) {}
        })
        assertTrue(initialTrue.await(10, TimeUnit.SECONDS))

        database.goOffline()
        database.goOnline()
        val valueAtGetter = Tasks.await(database.getReference(".info/connected").get(), 10, TimeUnit.SECONDS).value
        getterDone.set(true)

        database.goOffline()
        assertTrue(sentinelOffline.await(10, TimeUnit.SECONDS), "expected sentinel offline transition")

        assertEquals(true, valueAtGetter)
        assertEquals(listOf<Any?>(false), afterGetter.toList(), "no stale transition from before getter may arrive after it")
        assertEquals(listOf<Any?>(true, false, true, false), seen.toList())
    }

    @Test
    fun `K14 D7 Firestore RTDB and Auth listeners register before their call returns`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        assertEquals(2, bridge.ofType("worker-sub").size, "FirebaseAuth constructor must register authState and idToken synchronously")

        val firestore = FirebaseFirestore(client, app, "(default)", credentialsProvider = auth)
        repeat(5) { i ->
            val before = bridge.ofType("worker-sub").size
            firestore.document("rooms/doc$i").addSnapshotListener { _, _ -> }
            assertEquals(before + 1, bridge.ofType("worker-sub").size, "DocumentReference.addSnapshotListener #$i must register synchronously")
        }

        val beforeQuery = bridge.ofType("worker-sub").size
        firestore.collection("rooms").whereEqualTo("open", true).addSnapshotListener { _, _ -> }
        assertEquals(beforeQuery + 1, bridge.ofType("worker-sub").size, "Query.addSnapshotListener must register synchronously")

        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com", credentialsProvider = auth)
        val beforeVal = bridge.ofType("worker-sub").size
        database.getReference("rtdb/val").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        assertEquals(beforeVal + 1, bridge.ofType("worker-sub").size, "RTDB addValueEventListener must register synchronously")

        val beforeSingle = bridge.ofType("worker-sub").size
        database.getReference("rtdb/single").addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        assertEquals(beforeSingle + 1, bridge.ofType("worker-sub").size, "RTDB addListenerForSingleValueEvent must register synchronously")

        val beforeChild = bridge.ofType("worker-sub").size
        database.getReference("rtdb/child").addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        assertEquals(beforeChild + 1, bridge.ofType("worker-sub").size, "RTDB addChildEventListener must register synchronously")

        val messaging = FirebaseMessaging.getInstance(app, client)
        val beforeMsg = bridge.ofType("worker-sub").size
        messaging.registerService(object : FirebaseMessagingService() {})
        assertEquals(beforeMsg + 2, bridge.ofType("worker-sub").size, "FirebaseMessaging.registerService must register synchronously")
        messaging.close()
    }

    @Test
    fun `K16 D7 D8 bursts exceeding 64 frames are delivered in full to slow collectors and denial listeners`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val received = CopyOnWriteArrayList<Any?>()
        val enteredFirst = CountDownLatch(1)
        val releaseFirst = CountDownLatch(1)
        val sentinelDone = CountDownLatch(1)
        val subSent = CountDownLatch(1)
        bridge.onFrame = { frame ->
            if (subPath(frame) == "rooms/burst") subSent.countDown()
        }

        scope.launch {
            try {
                client.subscribe(mapOf("__ref" to "doc", "path" to "rooms/burst")).collect { value ->
                    if (received.isEmpty()) {
                        enteredFirst.countDown()
                        releaseFirst.await(10, TimeUnit.SECONDS)
                    }
                    received.add(value)
                    if (value == mapOf("n" to "end")) sentinelDone.countDown()
                }
            } catch (_: Throwable) {}
        }
        assertTrue(subSent.await(10, TimeUnit.SECONDS))
        val subId = bridge.subsFor("rooms/burst").single()["subId"]

        deliverSnap(subId, mapOf("n" to 0))
        assertTrue(enteredFirst.await(10, TimeUnit.SECONDS))
        for (i in 1 until 200) {
            deliverSnap(subId, mapOf("n" to i))
        }
        deliverSnap(subId, mapOf("n" to "end"))
        releaseFirst.countDown()

        assertTrue(sentinelDone.await(10, TimeUnit.SECONDS), "expected sentinel frame; got ${received.size}")
        assertEquals(201, received.size, "no frames may be dropped in a 201-frame burst")

        // Also verify denialEvents does not drop a 150-event burst.
        val firestore = FirebaseFirestore(client, app, "(default)")
        val denialsReceived = AtomicInteger(0)
        val denialEnteredFirst = CountDownLatch(1)
        val denialReleaseFirst = CountDownLatch(1)
        val allDenials = CountDownLatch(150)
        firestore.addRulesDenialListener { _, _ ->
            if (denialsReceived.incrementAndGet() == 1) {
                denialEnteredFirst.countDown()
                denialReleaseFirst.await(10, TimeUnit.SECONDS)
            }
            allDenials.countDown()
        }
        client.dispatchDenial(FirebaseFirestoreException("d0", FirebaseFirestoreException.Code.PERMISSION_DENIED))
        assertTrue(denialEnteredFirst.await(10, TimeUnit.SECONDS))
        for (i in 1 until 150) {
            client.dispatchDenial(FirebaseFirestoreException("d$i", FirebaseFirestoreException.Code.PERMISSION_DENIED))
        }
        denialReleaseFirst.countDown()
        assertTrue(allDenials.await(10, TimeUnit.SECONDS), "expected 150 denials, got ${denialsReceived.get()}")
        assertEquals(150, denialsReceived.get())

        // Also verify FirebaseAuth.idTokenFlow does not drop a 100-event burst.
        val auth = FirebaseAuth(app, client)
        val tokenEntered = CountDownLatch(1)
        val tokenRelease = CountDownLatch(1)
        val allTokens = CountDownLatch(101)
        val tokenCount = AtomicInteger(0)
        val tokenJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            auth.idTokenFlow().collect {
                if (tokenCount.incrementAndGet() == 1) {
                    tokenEntered.countDown()
                    tokenRelease.await(10, TimeUnit.SECONDS)
                }
                allTokens.countDown()
            }
        }
        assertTrue(tokenEntered.await(10, TimeUnit.SECONDS))
        repeat(100) { auth.notifyIdTokenChanged() }
        tokenRelease.countDown()
        assertTrue(allTokens.await(10, TimeUnit.SECONDS), "expected 101 idToken emissions, got ${tokenCount.get()}")
        tokenJob.cancel()
    }

    @Test
    fun `K17 D8 two bridge subscriptions keep their relative socket frame order`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val order = CopyOnWriteArrayList<String>()
        val bothSubbed = CountDownLatch(2)
        val allDelivered = CountDownLatch(100)
        bridge.onFrame = { frame ->
            val p = subPath(frame)
            if (p == "a/1" || p == "b/1") bothSubbed.countDown()
        }

        scope.launch {
            try {
                client.subscribe(mapOf("__ref" to "doc", "path" to "a/1")).collect { v ->
                    order.add("a:" + (v as Map<*, *>)["n"])
                    allDelivered.countDown()
                }
            } catch (_: Throwable) {}
        }
        scope.launch {
            try {
                client.subscribe(mapOf("__ref" to "doc", "path" to "b/1")).collect { v ->
                    order.add("b:" + (v as Map<*, *>)["n"])
                    allDelivered.countDown()
                }
            } catch (_: Throwable) {}
        }
        assertTrue(bothSubbed.await(10, TimeUnit.SECONDS))
        val subA = bridge.subsFor("a/1").single()["subId"]
        val subB = bridge.subsFor("b/1").single()["subId"]

        val expected = mutableListOf<String>()
        repeat(50) { i ->
            deliverSnap(subA, mapOf("n" to i))
            expected.add("a:$i")
            deliverSnap(subB, mapOf("n" to i))
            expected.add("b:$i")
        }
        assertTrue(allDelivered.await(10, TimeUnit.SECONDS), "expected 100 events, got ${order.size}")
        assertEquals(expected, order.toList())
    }

    @Test
    fun `K17 D8 Firestore and RTDB callbacks on one client keep their relative socket frame order`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)
        val firestore = FirebaseFirestore(client, app, "(default)")
        val database = FirebaseDatabase(client, app, "https://contract-default-rtdb.firebaseio.com")

        val order = CopyOnWriteArrayList<String>()
        val allDelivered = CountDownLatch(90)

        firestore.document("rooms/fs1").addSnapshotListener { snap, _ ->
            val n = snap?.get("n")
            if (n != null) {
                order.add("fs1:$n")
                allDelivered.countDown()
            }
        }
        database.getReference("rooms/rtdb1").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val n = snapshot.value
                if (n != null) {
                    order.add("rtdb:$n")
                    allDelivered.countDown()
                }
            }
            override fun onCancelled(error: DatabaseError) {}
        })
        firestore.document("rooms/fs2").addSnapshotListener { snap, _ ->
            val n = snap?.get("n")
            if (n != null) {
                order.add("fs2:$n")
                allDelivered.countDown()
            }
        }

        val fs1Sub = bridge.subsFor("rooms/fs1").single()["subId"]
        val rtdbSub = bridge.subsFor("rooms/rtdb1").single()["subId"]
        val fs2Sub = bridge.subsFor("rooms/fs2").single()["subId"]

        val expected = mutableListOf<String>()
        repeat(30) { i ->
            deliverSnap(fs1Sub, mapOf("id" to "fs1", "exists" to true, "data" to mapOf("n" to i)))
            expected.add("fs1:$i")
            deliverSnap(rtdbSub, mapOf("value" to i))
            expected.add("rtdb:$i")
            deliverSnap(fs2Sub, mapOf("id" to "fs2", "exists" to true, "data" to mapOf("n" to i)))
            expected.add("fs2:$i")
        }

        assertTrue(allDelivered.await(10, TimeUnit.SECONDS), "expected 90 callbacks, got ${order.size}")
        assertEquals(expected, order.toList())
    }

    @Test
    fun `finishAttach publishes ATTACHED only after releasing the hold queue so caller sends directly`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)
        val firestore = FirebaseFirestore(client, app, "(default)")

        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        val held = scope.async(start = CoroutineStart.UNDISPATCHED) {
            client.op("setDoc", mapOf("path" to "rooms/held"))
        }

        val releasingHeld = CountDownLatch(1)
        val continueRelease = CountDownLatch(1)
        val stateDuringRelease = java.util.concurrent.atomic.AtomicReference<BridgeConnectionState?>()
        val afterSendThread = java.util.concurrent.atomic.AtomicReference<Thread?>()

        bridge.onFrame = { frame ->
            @Suppress("UNCHECKED_CAST")
            val op = frame["op"] as? Map<String, Any?>
            val path = op?.get("path")
            if (frame["type"] == "worker-op" && path == "rooms/held") {
                stateDuringRelease.set(client.connectionState)
                releasingHeld.countDown()
                continueRelease.await(10, TimeUnit.SECONDS)
            } else if (frame["type"] == "worker-op" && path == "rooms/after") {
                afterSendThread.set(Thread.currentThread())
            }
        }

        bridge.refuseConnections = false
        assertTrue(releasingHeld.await(10, TimeUnit.SECONDS), "held op should begin releasing")
        assertNotEquals(
            BridgeConnectionState.ATTACHED,
            stateDuringRelease.get(),
            "connectionState must not read ATTACHED while held operations are still releasing"
        )
        continueRelease.countDown()

        awaitState(BridgeConnectionState.ATTACHED)
        val caller = Thread.currentThread()
        firestore.document("rooms/after").get()
        assertEquals(
            caller,
            afterSendThread.get(),
            "once connectionState reads ATTACHED, the next op must go directly on the caller's thread"
        )

        val heldFrame = bridge.opsNamed("setDoc").single()
        bridge.current.deliver(mapOf("type" to "worker-res", "id" to heldFrame["id"], "ok" to true, "value" to null))
        withTimeout(10_000) { held.await() }
        Unit
    }
}
