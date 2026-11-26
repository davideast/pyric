package dev.pyric.bridge

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckToken
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.database.ChildEventListener
import dev.pyric.database.DataSnapshot
import dev.pyric.database.DatabaseError
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ValueEventListener
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * Deterministic gate-based regression tests for PR 4 Round 2 concurrency fixes:
 * separate token vs authoritative wireSeq tracking (K19), mirroring mutations onto
 * the current FirebaseUser instance (K19), suppressing queued onCloseError callbacks
 * after remove()/removeEventListener() (K20), and cross-thread per-entry callback
 * serialization on Auth, Firestore denial, and App Check listeners (K20).
 */
class DeliveryContractCloseCancelEdgeTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "delivery-pr4-edge-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("pr4-edge-project")
                .setApiKey("pr4-edge-key")
                .setApplicationId("pr4-edge-app")
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
        FirebaseAppCheck.clearInstancesForTest()
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
    private fun subIdForTarget(targetName: String): Any? =
        bridge.ofType("worker-sub").last {
            ((it["sub"] as? Map<String, Any?>)?.get("target") as? String) == targetName
        }["subId"]

    @Test
    fun `K19 D9 newer idToken snap neither drops linkWithCredential rawData nor regresses claims`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val idTokenSubId = subIdForTarget("idToken")
        val linkOpId = AtomicReference<Any?>(null)
        val linkRequested = CountDownLatch(1)
        val enrichOpId = AtomicReference<Any?>(null)
        val enrichRequested = CountDownLatch(1)

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
                    enrichOpId.set(frame["id"])
                    enrichRequested.countDown()
                }
            }
        }

        val user = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user!!
        val linkTask = user.linkWithCredential(GoogleAuthProvider.getCredential("id-token", null))
        assertTrue(linkRequested.await(10, TimeUnit.SECONDS))
        // Respond at wireSeq N without claims so linkWithCredential suspends in enrichSignInResponseIfNeeded.
        deliverOpOk(linkOpId.get(), mapOf("user" to mapOf("uid" to "u1", "displayName" to "LinkedName")))
        assertTrue(enrichRequested.await(10, TimeUnit.SECONDS))

        // Deliver a non-null idToken snapshot at wireSeq N+1 with newer claims.
        val adminClaimApplied = CountDownLatch(1)
        auth.addIdTokenListener { a ->
            if (a.currentUser?.customClaims?.get("role") == "admin") {
                adminClaimApplied.countDown()
            }
        }
        deliverSnap(idTokenSubId, mapOf("uid" to "u1", "customClaims" to mapOf("role" to "admin")))
        assertTrue(adminClaimApplied.await(10, TimeUnit.SECONDS), "expected newer idToken claim to apply")

        // Release enrichment with older claims; rawData must still update without regressing claims.
        deliverOpOk(enrichOpId.get(), mapOf("claims" to mapOf("sub" to "u1", "role" to "stale")))
        Tasks.await(linkTask, 10, TimeUnit.SECONDS)

        assertEquals("LinkedName", auth.currentUser?.displayName)
        assertEquals("admin", auth.currentUser?.customClaims?.get("role"))
    }

    @Test
    fun `K19 D9 prior user idToken snap during signIn enrichment does not drop new signIn`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val idTokenSubId = subIdForTarget("idToken")
        val signInOpId = AtomicReference<Any?>(null)
        val signInRequested = CountDownLatch(1)
        val enrichOpId = AtomicReference<Any?>(null)
        val enrichRequested = CountDownLatch(1)

        bridge.onFrame = { frame ->
            when (opMethod(frame)) {
                "auth.signInAnonymously" -> deliverOpOk(
                    frame["id"],
                    mapOf("user" to mapOf("uid" to "u1", "isAnonymous" to true))
                )
                "auth.signInEmail" -> {
                    signInOpId.set(frame["id"])
                    signInRequested.countDown()
                }
                "auth.getIdTokenResult" -> {
                    enrichOpId.set(frame["id"])
                    enrichRequested.countDown()
                }
            }
        }

        Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
        assertEquals("u1", auth.currentUser?.uid)

        val signInTask = auth.signInWithEmailAndPassword("u2@b.c", "secret")
        assertTrue(signInRequested.await(10, TimeUnit.SECONDS))
        deliverOpOk(signInOpId.get(), mapOf("user" to mapOf("uid" to "u2"), "operationType" to "signIn"))
        assertTrue(enrichRequested.await(10, TimeUnit.SECONDS))

        val priorTokenApplied = CountDownLatch(1)
        auth.addIdTokenListener { a ->
            if (a.currentUser?.uid == "u1" && a.currentUser?.customClaims?.get("scope") == "prior") {
                priorTokenApplied.countDown()
            }
        }
        deliverSnap(idTokenSubId, mapOf("uid" to "u1", "customClaims" to mapOf("scope" to "prior")))
        assertTrue(priorTokenApplied.await(10, TimeUnit.SECONDS))

        deliverOpOk(enrichOpId.get(), mapOf("claims" to mapOf("sub" to "u2", "scope" to "fresh")))
        Tasks.await(signInTask, 10, TimeUnit.SECONDS)

        assertEquals("u2", auth.currentUser?.uid)
        assertEquals("fresh", auth.currentUser?.customClaims?.get("scope"))
    }

    @Test
    fun `K19 D9 getIdToken on older FirebaseUser handle does not regress currentUser rawData`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val authSubId = subIdForTarget("authState")

        bridge.onFrame = { frame ->
            when (opMethod(frame)) {
                "auth.signInAnonymously" -> deliverOpOk(
                    frame["id"],
                    mapOf("user" to mapOf("uid" to "u1", "displayName" to "OldName", "isAnonymous" to true))
                )
                "auth.getIdTokenResult" -> deliverOpOk(
                    frame["id"],
                    mapOf("token" to "tok-2", "claims" to mapOf("sub" to "u1", "tier" to "pro"))
                )
            }
        }

        val oldUser = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user!!
        assertEquals("OldName", auth.currentUser?.displayName)

        deliverSnap(authSubId, mapOf("uid" to "u1", "displayName" to "BridgeUpdated"))
        withTimeout(10_000) {
            auth.authStateFlow().first { it?.displayName == "BridgeUpdated" }
        }

        Tasks.await(oldUser.getIdToken(true), 10, TimeUnit.SECONDS)
        assertEquals("BridgeUpdated", auth.currentUser?.displayName)
        assertEquals("pro", auth.currentUser?.customClaims?.get("tier"))
        assertEquals("pro", oldUser.customClaims["tier"])
    }

    @Test
    fun `K20 D10 queued onCloseError does not fire after Firestore remove or RTDB removeEventListener`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val firestore = FirebaseFirestore(client, app, "(default)")
        val database = FirebaseDatabase(client, app, "https://pr4-edge-default-rtdb.firebaseio.com")

        val blockerEntered = CountDownLatch(1)
        val releaseBlocker = CountDownLatch(1)
        firestore.document("rooms/blocker").addSnapshotListener { snap, _ ->
            if (snap != null) {
                blockerEntered.countDown()
                releaseBlocker.await(10, TimeUnit.SECONDS)
            }
        }

        val docErrors = AtomicInteger(0)
        val docReg = firestore.document("rooms/doc").addSnapshotListener { _, err ->
            if (err != null) docErrors.incrementAndGet()
        }

        val queryErrors = AtomicInteger(0)
        val queryReg = firestore.collection("rooms").addSnapshotListener { _, err ->
            if (err != null) queryErrors.incrementAndGet()
        }

        val rtdbErrors = AtomicInteger(0)
        val rtdbRef = database.getReference("rooms/rtdb")
        val rtdbListener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {}
            override fun onCancelled(error: DatabaseError) {
                rtdbErrors.incrementAndGet()
            }
        }
        rtdbRef.addValueEventListener(rtdbListener)

        val blockerSubId = bridge.ofType("worker-sub").first()["subId"]
        deliverSnap(blockerSubId, mapOf("id" to "blocker", "exists" to true, "data" to mapOf("v" to 1)))
        assertTrue(blockerEntered.await(10, TimeUnit.SECONDS))

        // Enqueues deliverErrorOnce behind the parked blocker on deliveryQueue.
        client.disconnect()

        docReg.remove()
        queryReg.remove()
        rtdbRef.removeEventListener(rtdbListener)

        val queueDrained = CountDownLatch(1)
        client.deliveryQueue.enqueue { queueDrained.countDown() }
        releaseBlocker.countDown()
        assertTrue(queueDrained.await(10, TimeUnit.SECONDS))

        assertEquals(0, docErrors.get(), "Firestore doc listener must not receive queued close error after remove()")
        assertEquals(0, queryErrors.get(), "Firestore query listener must not receive queued close error after remove()")
        assertEquals(0, rtdbErrors.get(), "RTDB listener must not receive queued close error after removeEventListener()")
    }

    @Test
    fun `K20 D10 cross-thread listener removal waits for in-flight callback and AppCheck skips removed sibling`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val auth = FirebaseAuth(app, client)
        val arm = AtomicBoolean(false)
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val inCallback = AtomicBoolean(false)
        val stillRunningAfterRemove = AtomicBoolean(false)
        val removeFinished = CountDownLatch(1)

        val slowListener = FirebaseAuth.AuthStateListener {
            if (!arm.get()) return@AuthStateListener
            inCallback.set(true)
            entered.countDown()
            release.await(10, TimeUnit.SECONDS)
            inCallback.set(false)
        }
        auth.addAuthStateListener(slowListener)
        arm.set(true)

        val notifyThread = Thread { auth.signOut() }
        notifyThread.start()
        assertTrue(entered.await(10, TimeUnit.SECONDS))

        val removerThread = Thread {
            auth.removeAuthStateListener(slowListener)
            stillRunningAfterRemove.set(inCallback.get())
            removeFinished.countDown()
        }
        removerThread.start()
        val authDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (removerThread.state != Thread.State.BLOCKED && removeFinished.count > 0 && System.nanoTime() < authDeadline) {
            Thread.yield()
        }
        assertEquals(Thread.State.BLOCKED, removerThread.state, "removeAuthStateListener must block until in-flight callback exits")
        release.countDown()
        assertTrue(removeFinished.await(10, TimeUnit.SECONDS))
        notifyThread.join(10_000)
        removerThread.join(10_000)
        assertFalse(stillRunningAfterRemove.get(), "callback must have exited before removeAuthStateListener returned")

        val firestore = FirebaseFirestore(client, app, "(default)")
        val denialEntered = CountDownLatch(1)
        val denialRelease = CountDownLatch(1)
        val denialInCallback = AtomicBoolean(false)
        val denialRunningAfterRemove = AtomicBoolean(false)
        val denialRemoveDone = CountDownLatch(1)
        val denialReg = firestore.addRulesDenialListener { _, _ ->
            denialInCallback.set(true)
            denialEntered.countDown()
            denialRelease.await(10, TimeUnit.SECONDS)
            denialInCallback.set(false)
        }
        val denialThread = Thread {
            firestore.notifyRulesDenial(
                FirebaseFirestoreException("denied", FirebaseFirestoreException.Code.PERMISSION_DENIED)
            )
        }
        denialThread.start()
        assertTrue(denialEntered.await(10, TimeUnit.SECONDS))
        val denialRemover = Thread {
            denialReg.remove()
            denialRunningAfterRemove.set(denialInCallback.get())
            denialRemoveDone.countDown()
        }
        denialRemover.start()
        val denialDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (denialRemover.state != Thread.State.BLOCKED && denialRemoveDone.count > 0 && System.nanoTime() < denialDeadline) {
            Thread.yield()
        }
        assertEquals(Thread.State.BLOCKED, denialRemover.state, "RulesDenialListener remove() must wait for in-flight callback")
        denialRelease.countDown()
        assertTrue(denialRemoveDone.await(10, TimeUnit.SECONDS))
        denialThread.join(10_000)
        denialRemover.join(10_000)
        assertFalse(denialRunningAfterRemove.get())

        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory {
            AppCheckProvider {
                Tasks.forResult(object : AppCheckToken() {
                    override val token: String = "tok-appcheck"
                    override val expireTimeMillis: Long = System.currentTimeMillis() + 60_000L
                })
            }
        }
        val appCheckBCalls = AtomicInteger(0)
        val appCheckB = FirebaseAppCheck.AppCheckListener { appCheckBCalls.incrementAndGet() }
        appCheck.addAppCheckListener { appCheck.removeAppCheckListener(appCheckB) }
        appCheck.addAppCheckListener(appCheckB)
        Tasks.await(appCheck.getAppCheckToken(true), 10, TimeUnit.SECONDS)
        assertEquals(0, appCheckBCalls.get(), "AppCheckListener removed by sibling callback must not fire")
    }

    @Test
    fun `RtdbSnapshotRegistration delivers initial child snapshot arriving before constructor returns`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val database = FirebaseDatabase(client, app, "https://pr4-edge-default-rtdb.firebaseio.com")
        val addedKeys = java.util.concurrent.CopyOnWriteArrayList<String?>()
        val bothAdded = CountDownLatch(2)

        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-sub") {
                val payload = mapOf("a" to 1, "b" to 2)
                deliverSnap(frame["subId"], mapOf("exists" to true, "value" to payload, "exportValue" to payload))
                // Force deliveryQueue to run onSnapshot before RtdbSnapshotRegistration() returns.
                assertTrue(bothAdded.await(10, TimeUnit.SECONDS), "expected child Added callbacks during constructor")
            }
        }

        val listener = database.getReference("catalog").addChildEventListener(object : ChildEventListener {
            override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                addedKeys.add(snapshot.key)
                bothAdded.countDown()
            }
            override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onChildRemoved(snapshot: DataSnapshot) {}
            override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {}
            override fun onCancelled(error: DatabaseError) {}
        })
        database.getReference("catalog").removeEventListener(listener)
        assertEquals(listOf("a", "b"), addedKeys.toList())
    }
}
