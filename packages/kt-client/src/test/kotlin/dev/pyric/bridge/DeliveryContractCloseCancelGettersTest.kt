package dev.pyric.bridge

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.pyric.auth.AuthLens
import dev.pyric.database.ChildEventListener
import dev.pyric.database.DataSnapshot
import dev.pyric.database.DatabaseError
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ValueEventListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Deterministic gate-based tests covering ADR-0019 Kotlin Milestone 4
 * findings: K11 (D6 buffered frames dropped at close), K18 (D9 RTDB lens
 * getter consistency), K19 (D9 monotonic Auth state across enrichment and
 * user mutations), K20 (D10 zero callbacks after removal across all listener
 * surfaces), and K21 (D10 detached cancel & duplicate unsubscribe).
 */
class DeliveryContractCloseCancelGettersTest {
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
        FirebaseMessaging.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "delivery-pr4-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("pr4-project")
                .setApiKey("pr4-key")
                .setApplicationId("pr4-app")
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

    private fun deliverSnap(subId: Any?, value: Any?) {
        bridge.current.deliver(mapOf("type" to "worker-snap", "subId" to subId, "value" to value))
    }

    private fun deliverOpOk(id: Any?, value: Any?) {
        bridge.current.deliver(mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to value))
    }

    @Suppress("UNCHECKED_CAST")
    private fun opMethod(frame: Map<String, Any?>): String? {
        if (frame["type"] != "worker-op") return null
        return (frame["op"] as? Map<String, Any?>)?.get("method") as? String
    }

    @Suppress("UNCHECKED_CAST")
    private fun subPath(frame: Map<String, Any?>): String? {
        if (frame["type"] != "worker-sub") return null
        val target = (frame["sub"] as? Map<String, Any?>)?.get("target") as? Map<String, Any?>
        return target?.get("path") as? String
    }

    @Test
    fun `K11 D6 subscribe Firestore and RTDB drop buffered frames after disconnect and policy close 1008`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val firestore = FirebaseFirestore(client, app, "(default)")
        val database = FirebaseDatabase(client, app, "https://pr4-default-rtdb.firebaseio.com")

        val flowFirst = CountDownLatch(1)
        val flowGate = CountDownLatch(1)
        val flowDone = CountDownLatch(1)
        val closedFlag = AtomicBoolean(false)
        val flowAfterClose = AtomicInteger(0)
        val flowError = AtomicReference<Throwable?>(null)

        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                client.subscribe(mapOf("__ref" to "doc", "path" to "flow/a")).collect {
                    if (closedFlag.get()) flowAfterClose.incrementAndGet()
                    flowFirst.countDown()
                    flowGate.await(10, TimeUnit.SECONDS)
                }
            } catch (e: Throwable) {
                flowError.set(e)
            } finally {
                flowDone.countDown()
            }
        }

        val fsAfterClose = AtomicInteger(0)
        val fsErrors = AtomicInteger(0)
        val fsErrorLatch = CountDownLatch(1)
        firestore.document("fs/a").addSnapshotListener { snap, err ->
            if (snap != null && closedFlag.get()) fsAfterClose.incrementAndGet()
            if (err != null) {
                fsErrors.incrementAndGet()
                fsErrorLatch.countDown()
            }
        }

        val rtdbAfterClose = AtomicInteger(0)
        val rtdbErrors = AtomicInteger(0)
        val rtdbErrorLatch = CountDownLatch(1)
        database.getReference("rtdb/a").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (closedFlag.get()) rtdbAfterClose.incrementAndGet()
            }

            override fun onCancelled(error: DatabaseError) {
                rtdbErrors.incrementAndGet()
                rtdbErrorLatch.countDown()
            }
        })

        val subs = bridge.ofType("worker-sub")
        assertEquals(3, subs.size)
        val flowSubId = subs[0]["subId"]
        val fsSubId = subs[1]["subId"]
        val rtdbSubId = subs[2]["subId"]

        deliverSnap(flowSubId, mapOf("v" to 0))
        assertTrue(flowFirst.await(10, TimeUnit.SECONDS))

        // Delivery queue is parked inside flowSubId's first emit; queue 5 frames on every listener.
        repeat(5) { i ->
            deliverSnap(flowSubId, mapOf("v" to i + 1))
            deliverSnap(fsSubId, mapOf("id" to "a", "exists" to true, "data" to mapOf("v" to i)))
            deliverSnap(rtdbSubId, mapOf("exists" to true, "value" to i, "exportValue" to i))
        }

        client.disconnect()
        closedFlag.set(true)
        flowGate.countDown()

        assertTrue(flowDone.await(10, TimeUnit.SECONDS))
        assertTrue(fsErrorLatch.await(10, TimeUnit.SECONDS))
        assertTrue(rtdbErrorLatch.await(10, TimeUnit.SECONDS))
        assertNotNull(flowError.get())
        assertEquals(0, flowAfterClose.get(), "subscribe() must drop buffered frames after disconnect()")
        assertEquals(0, fsAfterClose.get(), "Firestore listener must drop buffered frames after disconnect()")
        assertEquals(0, rtdbAfterClose.get(), "RTDB listener must drop buffered frames after disconnect()")
        assertEquals(1, fsErrors.get())
        assertEquals(1, rtdbErrors.get())
    }

    private suspend fun assertSequencedChannelDrainedWithError(
        handle: SequencedSubscriptionHandle,
        label: String
    ) {
        val delivered = mutableListOf<Any?>()
        var closeCause: Throwable? = null
        try {
            for (item in handle.channel) {
                delivered.add(item.value)
            }
        } catch (e: Throwable) {
            closeCause = e
        }
        assertEquals(emptyList<Any?>(), delivered, "unread sequenced snapshots must be dropped on $label")
        assertTrue(closeCause is FirebaseFirestoreException, "expected terminal FirebaseFirestoreException on $label, got $closeCause")
    }

    @Test
    fun `K11 D6 sequenced subscription drops buffered frames on disconnect and on no-retry close 1008`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val seqHandle = client.openSequencedSubscription("authState")
        val subId = bridge.ofType("worker-sub").last()["subId"]
        repeat(5) { i -> deliverSnap(subId, mapOf("uid" to "buffered-$i")) }

        client.disconnect()
        assertSequencedChannelDrainedWithError(seqHandle, "disconnect()")
    }

    @Test
    fun `K11 D6 policy close 1008 drops buffered frames on sequenced subscription without retry`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val seqHandle = client.openSequencedSubscription("idToken")
        val subId = bridge.ofType("worker-sub").last()["subId"]
        repeat(4) { i -> deliverSnap(subId, mapOf("uid" to "token-$i")) }

        bridge.current.drop(code = 1008)
        awaitState(BridgeConnectionState.CLOSED)
        assertSequencedChannelDrainedWithError(seqHandle, "close 1008")
    }

    @Test
    fun `K18 D9 RTDB lens getter and outgoing actAs reflect auth lens changes synchronously`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val database = FirebaseDatabase(client, app, "https://pr4-default-rtdb.firebaseio.com", credentialsProvider = auth)

        val recordedActAs = CopyOnWriteArrayList<Map<String, Any?>?>()
        bridge.onFrame = { frame ->
            if (opMethod(frame) == "rtdb.set") {
                @Suppress("UNCHECKED_CAST")
                val actAs = (frame["op"] as? Map<String, Any?>)?.get("actAs") as? Map<String, Any?>
                recordedActAs.add(actAs)
            }
        }

        repeat(20) { i ->
            val lens = if (i % 2 == 0) AuthLens.Admin else AuthLens.AsUser(uid = "user-$i")
            auth.setAuthLens(lens)
            assertEquals(lens, database.getEffectiveAuthLens(), "getter lagged auth.setAuthLens on iteration $i")
            database.getReference("items/$i").setValue(i)
            assertEquals(lens.toMap(), recordedActAs.last(), "outgoing actAs lagged auth.setAuthLens on iteration $i")
        }

        val overrideLens = AuthLens.AsUser(uid = "override-u")
        database.setAuthLens(overrideLens)
        assertEquals(overrideLens, database.getEffectiveAuthLens())
        database.setAuthLens(null)
        assertEquals(auth.getEffectiveLens(), database.getEffectiveAuthLens())

        auth.signOut()
        assertEquals(AuthLens.Anon, database.getEffectiveAuthLens())
    }

    @Test
    fun `K19 D9 stale signIn suspended in token enrichment never resurrects user after signOut`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val enrichmentOpId = AtomicReference<Any?>(null)
        val enrichmentRequested = CountDownLatch(1)
        val signInOpId = AtomicReference<Any?>(null)
        val signInRequested = CountDownLatch(1)

        bridge.onFrame = { frame ->
            when (opMethod(frame)) {
                "auth.signInEmail" -> {
                    signInOpId.set(frame["id"])
                    signInRequested.countDown()
                }
                "auth.getIdTokenResult" -> {
                    enrichmentOpId.set(frame["id"])
                    enrichmentRequested.countDown()
                }
                "auth.signOut" -> deliverOpOk(frame["id"], null)
            }
        }

        val signInTask = auth.signInWithEmailAndPassword("a@b.c", "secret")
        assertTrue(signInRequested.await(10, TimeUnit.SECONDS))
        // Reply without embedded claims so signInWithEmailAndPassword suspends in enrichSignInResponseIfNeeded.
        deliverOpOk(signInOpId.get(), mapOf("user" to mapOf("uid" to "stale-user"), "operationType" to "signIn"))
        assertTrue(enrichmentRequested.await(10, TimeUnit.SECONDS))

        val seenAfterSignOut = CopyOnWriteArrayList<String?>()
        val afterSignOut = AtomicBoolean(false)
        auth.addAuthStateListener { a ->
            if (afterSignOut.get()) {
                seenAfterSignOut.add(a.currentUser?.uid)
            }
        }

        auth.signOut()
        afterSignOut.set(true)
        assertNull(auth.currentUser)

        // Now release the enrichment call for the older sign-in.
        deliverOpOk(enrichmentOpId.get(), mapOf("claims" to mapOf("sub" to "stale-user", "role" to "member")))
        Tasks.await(signInTask, 10, TimeUnit.SECONDS)

        assertNull(auth.currentUser, "stale signIn must not resurrect signed-out user")
        assertEquals(emptyList<String?>(), seenAfterSignOut.toList(), "no AuthStateListener may observe resurrected user")
    }

    @Test
    fun `K19 D9 stale linkWithCredential completing after newer updateProfile never overwrites user fields`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val linkEnrichId = AtomicReference<Any?>(null)
        val linkEnrichRequested = CountDownLatch(1)
        val linkOpId = AtomicReference<Any?>(null)
        val linkRequested = CountDownLatch(1)

        bridge.onFrame = { frame ->
            when (opMethod(frame)) {
                "auth.signInAnonymously" -> deliverOpOk(
                    frame["id"],
                    mapOf("user" to mapOf("uid" to "u1", "displayName" to "Initial", "isAnonymous" to true))
                )
                "auth.linkWithCredential" -> {
                    linkOpId.set(frame["id"])
                    linkRequested.countDown()
                }
                "auth.getIdTokenResult" -> {
                    linkEnrichId.set(frame["id"])
                    linkEnrichRequested.countDown()
                }
                "auth.updateProfile" -> deliverOpOk(
                    frame["id"],
                    mapOf("uid" to "u1", "displayName" to "FreshName")
                )
            }
        }

        val user = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user!!
        assertEquals("Initial", auth.currentUser?.displayName)

        val linkTask = user.linkWithCredential(GoogleAuthProvider.getCredential("id-token", null))
        assertTrue(linkRequested.await(10, TimeUnit.SECONDS))
        deliverOpOk(linkOpId.get(), mapOf("user" to mapOf("uid" to "u1", "displayName" to "StaleName")))
        assertTrue(linkEnrichRequested.await(10, TimeUnit.SECONDS))

        // Newer profile mutation finishes at a strictly higher wireSeq while linkWithCredential is suspended.
        Tasks.await(
            user.updateProfile(UserProfileChangeRequest.Builder().setDisplayName("FreshName").build()),
            10,
            TimeUnit.SECONDS
        )
        assertEquals("FreshName", auth.currentUser?.displayName)

        val idTokenAfterFresh = AtomicInteger(0)
        val armed = AtomicBoolean(false)
        auth.addIdTokenListener {
            if (armed.get()) idTokenAfterFresh.incrementAndGet()
        }
        armed.set(true)

        deliverOpOk(linkEnrichId.get(), mapOf("claims" to mapOf("sub" to "u1")))
        Tasks.await(linkTask, 10, TimeUnit.SECONDS)

        assertEquals("FreshName", auth.currentUser?.displayName, "stale linkWithCredential must not overwrite newer displayName")
        assertEquals(0, idTokenAfterFresh.get(), "stale linkWithCredential must not emit a spurious IdTokenListener event")
    }

    @Test
    fun `K20 D10 Firestore RTDB and info singleEvent listeners receive nothing after removal returns`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val firestore = FirebaseFirestore(client, app, "(default)")
        val database = FirebaseDatabase(client, app, "https://pr4-default-rtdb.firebaseio.com")

        val fsEntered = CountDownLatch(1)
        val fsGate = CountDownLatch(1)
        val fsRemoved = AtomicBoolean(false)
        val fsAfterRemove = AtomicInteger(0)
        val fsReg = firestore.document("rooms/a").addSnapshotListener { snap, _ ->
            if (snap == null) return@addSnapshotListener
            if (fsRemoved.get()) fsAfterRemove.incrementAndGet()
            fsEntered.countDown()
            fsGate.await(10, TimeUnit.SECONDS)
        }

        val rtdbRemoved = AtomicBoolean(false)
        val rtdbAfterRemove = AtomicInteger(0)
        val rtdbRef = database.getReference("rooms/a")
        val rtdbListener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { if (rtdbRemoved.get()) rtdbAfterRemove.incrementAndGet() }
            override fun onCancelled(error: DatabaseError) {}
        }
        rtdbRef.addValueEventListener(rtdbListener)

        val childRemoved = AtomicBoolean(false)
        val childAfterRemove = AtomicInteger(0)
        val childRef = database.getReference("rooms/children")
        val childListener = object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) { if (childRemoved.get()) childAfterRemove.incrementAndGet() }
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) { if (childRemoved.get()) childAfterRemove.incrementAndGet() }
            override fun onChildRemoved(snapshot: DataSnapshot) { if (childRemoved.get()) childAfterRemove.incrementAndGet() }
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) { if (childRemoved.get()) childAfterRemove.incrementAndGet() }
            override fun onCancelled(error: DatabaseError) {}
        }
        childRef.addChildEventListener(childListener)

        val sentinelDone = CountDownLatch(1)
        val sentinelReg = firestore.document("rooms/sentinel").addSnapshotListener { snap, _ ->
            if (snap != null) sentinelDone.countDown()
        }

        val subs = bridge.ofType("worker-sub")
        assertEquals(4, subs.size)
        val fsSubId = subs[0]["subId"]
        val rtdbSubId = subs[1]["subId"]
        val childSubId = subs[2]["subId"]
        val sentinelSubId = subs[3]["subId"]

        deliverSnap(fsSubId, mapOf("id" to "a", "exists" to true, "data" to mapOf("v" to 0)))
        assertTrue(fsEntered.await(10, TimeUnit.SECONDS))

        repeat(3) { i ->
            deliverSnap(fsSubId, mapOf("id" to "a", "exists" to true, "data" to mapOf("v" to i + 1)))
            deliverSnap(rtdbSubId, mapOf("exists" to true, "value" to i, "exportValue" to i))
            deliverSnap(childSubId, mapOf("exists" to true, "value" to mapOf("k$i" to i), "exportValue" to mapOf("k$i" to i)))
        }

        fsReg.remove()
        fsRemoved.set(true)
        rtdbRef.removeEventListener(rtdbListener)
        rtdbRemoved.set(true)
        childRef.removeEventListener(childListener)
        childRemoved.set(true)

        deliverSnap(sentinelSubId, mapOf("id" to "sentinel", "exists" to true, "data" to mapOf("ok" to true)))
        fsGate.countDown()
        assertTrue(sentinelDone.await(10, TimeUnit.SECONDS), "expected sentinel snapshot to drain deliveryQueue")

        assertEquals(0, fsAfterRemove.get())
        assertEquals(0, rtdbAfterRemove.get())
        assertEquals(0, childAfterRemove.get())
        sentinelReg.remove()

        // Single-value .info/connected listener that calls goOffline() inside onDataChange fires once.
        val infoSeen = CopyOnWriteArrayList<Any?>()
        val infoFirst = CountDownLatch(1)
        val infoOfflineSentinel = CountDownLatch(1)
        database.getReference(".info/connected").addValueEventListener(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) { if (snapshot.value == false) infoOfflineSentinel.countDown() }
            override fun onCancelled(error: DatabaseError) {}
        })
        database.getReference(".info/connected").addListenerForSingleValueEvent(object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                infoSeen.add(snapshot.value)
                infoFirst.countDown()
                database.goOffline()
            }
            override fun onCancelled(error: DatabaseError) {}
        })
        assertTrue(infoFirst.await(10, TimeUnit.SECONDS))
        assertTrue(infoOfflineSentinel.await(10, TimeUnit.SECONDS))
        assertEquals(listOf<Any?>(true), infoSeen.toList())
    }

    @Test
    fun `K20 D10 AuthState IdToken RulesDenial and Messaging listeners removed during sibling callback never fire`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val authBCalls = AtomicInteger(0)
        val authB = FirebaseAuth.AuthStateListener { authBCalls.incrementAndGet() }
        val armAuth = AtomicBoolean(false)
        auth.addAuthStateListener {
            if (armAuth.get()) auth.removeAuthStateListener(authB)
        }
        auth.addAuthStateListener(authB)
        authBCalls.set(0)
        armAuth.set(true)

        val tokenBCalls = AtomicInteger(0)
        val tokenB = FirebaseAuth.IdTokenListener { tokenBCalls.incrementAndGet() }
        val armToken = AtomicBoolean(false)
        auth.addIdTokenListener {
            if (armToken.get()) auth.removeIdTokenListener(tokenB)
        }
        auth.addIdTokenListener(tokenB)
        tokenBCalls.set(0)
        armToken.set(true)

        auth.signOut()
        assertEquals(0, authBCalls.get(), "AuthStateListener removed by sibling callback must not fire")
        assertEquals(0, tokenBCalls.get(), "IdTokenListener removed by sibling callback must not fire")

        val firestore = FirebaseFirestore(client, app, "(default)")
        val denialBCalls = AtomicInteger(0)
        val denialB = FirebaseFirestore.RulesDenialListener { _, _ -> denialBCalls.incrementAndGet() }
        lateinit var denialBReg: com.google.firebase.firestore.ListenerRegistration
        firestore.addRulesDenialListener { _, _ -> denialBReg.remove() }
        denialBReg = firestore.addRulesDenialListener(denialB)
        firestore.notifyRulesDenial(
            FirebaseFirestoreException("denied", FirebaseFirestoreException.Code.PERMISSION_DENIED)
        )
        assertEquals(0, denialBCalls.get(), "RulesDenialListener removed by sibling callback must not fire")

        val messaging = FirebaseMessaging.getInstance(app, client)
        val msgBCalls = AtomicInteger(0)
        val msgDone = CountDownLatch(1)
        val serviceB = object : FirebaseMessagingService() {
            override fun onMessageReceived(message: RemoteMessage) { msgBCalls.incrementAndGet() }
        }
        val serviceA = object : FirebaseMessagingService() {
            override fun onMessageReceived(message: RemoteMessage) { messaging.unregisterService(serviceB) }
        }
        val serviceC = object : FirebaseMessagingService() {
            override fun onMessageReceived(message: RemoteMessage) { msgDone.countDown() }
        }
        messaging.registerService(serviceA)
        messaging.registerService(serviceB)
        messaging.registerService(serviceC)
        val fgSubId = bridge.ofType("worker-sub").first {
            @Suppress("UNCHECKED_CAST")
            ((it["sub"] as? Map<String, Any?>)?.get("target") as? String) == "messaging.foreground"
        }["subId"]
        deliverSnap(fgSubId, mapOf("messageId" to "m1", "data" to mapOf("k" to "v")))
        assertTrue(msgDone.await(10, TimeUnit.SECONDS))
        assertEquals(0, msgBCalls.get(), "FirebaseMessagingService unregistered by sibling callback must not fire")
        messaging.close()
    }

    @Test
    fun `K21 D10 listener opened and cancelled while interrupted sends zero frames on re-attach and duplicate cancel sends unsub once`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val firestore = FirebaseFirestore(client, app, "(default)")
        val liveReg = firestore.document("rooms/live").addSnapshotListener { _, _ -> }
        val liveSubId = bridge.ofType("worker-sub").last()["subId"]
        liveReg.remove()
        liveReg.remove()
        assertEquals(
            1,
            bridge.ofType("worker-unsub").count { it["subId"] == liveSubId },
            "calling remove() twice must send worker-unsub at most once"
        )

        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        val detachedReg = firestore.document("rooms/detached").addSnapshotListener { _, _ -> }
        detachedReg.remove()

        val reattachedFrames = CopyOnWriteArrayList<Map<String, Any?>>()
        bridge.onFrame = { frame -> reattachedFrames.add(frame) }
        bridge.refuseConnections = false
        awaitState(BridgeConnectionState.ATTACHED)

        assertEquals(0, reattachedFrames.count { subPath(it) == "rooms/detached" }, "detached cancelled listener must not send worker-sub")
        assertEquals(0, reattachedFrames.count { it["type"] == "worker-unsub" }, "never-sent listener must not send worker-unsub")
    }
}
