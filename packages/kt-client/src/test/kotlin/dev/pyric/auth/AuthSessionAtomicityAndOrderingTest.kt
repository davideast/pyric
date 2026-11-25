package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Verifies atomic publication of `currentUser` and `effectiveLens` alongside
 * wire-sequence ordering so queued `null` snapshots from an earlier `signOut()`
 * cannot erase a subsequent sign-in when `Dispatchers.IO` collectors drain late.
 */
class AuthSessionAtomicityAndOrderingTest {

    @AfterEach
    fun tearDown() {
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun awaitCondition(timeoutMs: Long = 3_000L, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (predicate()) return
            Thread.sleep(10)
        }
        assertTrue(predicate(), "Timed out waiting for condition after ${timeoutMs}ms")
    }

    private fun newApp(name: String): FirebaseApp =
        FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("demo-project")
                .setApiKey("demo-key")
                .setApplicationId("1:123456:android:demo")
                .build()
        )

    @Test
    fun currentUserAndAuthStateFlowNeverPublishAheadOfEffectiveLens() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        val authStateSubId = AtomicReference<String?>(null)
        val idTokenSubId = AtomicReference<String?>(null)
        val activeTokenSub = AtomicReference("user-0")
        val sentDocActAs = CopyOnWriteArrayList<Map<String, Any?>>()

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    if (sub["target"] == "authState") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        authStateSubId.set(subId)
                    } else if (sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        idTokenSubId.set(subId)
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.getIdTokenResult" -> {
                            val sub = activeTokenSub.get()
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"$sub","role":"member"},"signInProvider":"password"}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "getDoc" -> {
                            @Suppress("UNCHECKED_CAST")
                            sentDocActAs.add((op["actAs"] as? Map<String, Any?>) ?: emptyMap())
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"item-1","path":"items/item-1","exists":false}}"""
                            )
                        }
                    }
                }
            }
        }

        val app = newApp("atomic-user-and-lens")
        val auth = FirebaseAuth.getInstance(app, bridge)
        val firestore = FirebaseFirestore(bridge, app, "(default)", credentialsProvider = auth)
        awaitCondition { bridge.isConnected && authStateSubId.get() != null && idTokenSubId.get() != null }

        val mismatchFailure = AtomicReference<Throwable?>(null)
        val stopPolling = AtomicBoolean(false)
        val pollerReady = CountDownLatch(1)
        val poller = Thread {
            pollerReady.countDown()
            var lastSeenUid: String? = null
            try {
                while (!stopPolling.get()) {
                    val userBefore = auth.currentUser
                    if (userBefore != null) {
                        lastSeenUid = userBefore.uid
                        val lens = auth.getEffectiveLens()
                        val flowLens = auth.authLensFlow.value
                        val userAfter = auth.currentUser
                        if (userAfter?.uid == userBefore.uid) {
                            val asUser = lens as AuthLens.AsUser
                            assertEquals(userBefore.uid, asUser.uid)
                            assertEquals("member", asUser.token?.get("role"))
                            val flowAsUser = flowLens as AuthLens.AsUser
                            assertEquals(userBefore.uid, flowAsUser.uid)
                            assertEquals("member", flowAsUser.token?.get("role"))
                        }
                    } else {
                        val priorUid = lastSeenUid
                        val lens = auth.getEffectiveLens()
                        if (priorUid != null && lens is AuthLens.AsUser && lens.uid == priorUid) {
                            throw AssertionError(
                                "Observed currentUser=null before getEffectiveLens() cleared stale uid=$priorUid"
                            )
                        }
                    }
                    Thread.onSpinWait()
                }
            } catch (t: Throwable) {
                mismatchFailure.compareAndSet(null, t)
            }
        }
        poller.start()
        assertTrue(pollerReady.await(3, TimeUnit.SECONDS))

        val unconfinedScope = CoroutineScope(Dispatchers.Unconfined)
        val flowLensSnapshot = CopyOnWriteArrayList<Pair<String, AuthLens>>()
        val flowJob = unconfinedScope.launch {
            auth.authStateFlow().collect { user ->
                if (user != null) {
                    flowLensSnapshot.add(user.uid to auth.getEffectiveLens())
                    firestore.document("items/item-1").get()
                }
            }
        }

        try {
            val subId = authStateSubId.get()!!
            repeat(40) { cycle ->
                mismatchFailure.get()?.let { throw it }
                val uid = "user-$cycle"
                activeTokenSub.set(uid)
                val userJson = """{"uid":"$uid","email":"$uid@example.com","isAnonymous":false}"""
                transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":$userJson}""")
                awaitCondition { auth.currentUser?.uid == uid }
                val lens = auth.getEffectiveLens() as AuthLens.AsUser
                assertEquals(uid, lens.uid)
                assertEquals("member", lens.token?.get("role"))
                auth.signOut()
                assertNull(auth.currentUser)
                assertEquals(AuthLens.Anon, auth.getEffectiveLens())
            }
            mismatchFailure.get()?.let { throw it }

            assertEquals(40, flowLensSnapshot.size, "Expected authStateFlow to emit every signed-in user")
            for ((uid, lens) in flowLensSnapshot) {
                assertTrue(
                    lens is AuthLens.AsUser && lens.uid == uid && lens.token?.get("role") == "member",
                    "authStateFlow emitted $uid before effectiveLens updated: $lens"
                )
            }
            awaitCondition { sentDocActAs.size >= flowLensSnapshot.size }
            assertTrue(
                sentDocActAs.all {
                    it["mode"] == "as" &&
                        (it["uid"] as? String)?.startsWith("user-") == true &&
                        (it["token"] as? Map<*, *>)?.get("role") == "member"
                },
                "Firestore get() triggered from authStateFlow sent stale actAs: $sentDocActAs"
            )
        } finally {
            stopPolling.set(true)
            poller.join(2_000)
            flowJob.cancel()
            unconfinedScope.cancel()
        }
    }

    @Test
    fun staleSignOutBridgeNullSnapshotsNeverEraseSubsequentSignIn() {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        val lock = Any()

        val authStateSubId = AtomicReference<String?>(null)
        val idTokenSubId = AtomicReference<String?>(null)
        val holdCollectorFetches = AtomicBoolean(false)
        val bothCollectorsHeld = CountDownLatch(2)
        val releaseHeldCollectors = CountDownLatch(1)
        val heldCollectorsFinished = CountDownLatch(2)

        val ownerJson = """{"uid":"owner-1","email":"owner@example.com","isAnonymous":false}"""
        val staleProbeJson = """{"uid":"probe-2","email":"probe@example.com","isAnonymous":false}"""
        val anonJson = """{"uid":"anonymous-kt-repro-1","isAnonymous":true,"providerId":"firebase"}"""

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> synchronized(lock) {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    if (sub["target"] == "authState") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        authStateSubId.set(subId)
                    } else if (sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        idTokenSubId.set(subId)
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.signInEmail" -> synchronized(lock) {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":$ownerJson,"providerId":"password","operationType":"signIn","claims":{"sub":"owner-1"}}}"""
                            )
                        }
                        "auth.getIdTokenResult" -> {
                            if (holdCollectorFetches.get()) {
                                bothCollectorsHeld.countDown()
                                Thread {
                                    releaseHeldCollectors.await(5, TimeUnit.SECONDS)
                                    transport.sendToClient(
                                        """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"anonymous-kt-repro-1"},"signInProvider":"anonymous"}}"""
                                    )
                                    heldCollectorsFinished.countDown()
                                }.start()
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"owner-1"},"signInProvider":"password"}}"""
                                )
                            }
                        }
                        "auth.signOut" -> synchronized(lock) {
                            // Mirror real Node host ordering: authState=null and idToken=null
                            // broadcast before auth.signOut worker-res.
                            authStateSubId.get()?.let { sId ->
                                transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":null}""")
                            }
                            idTokenSubId.get()?.let { sId ->
                                transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":null}""")
                            }
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.signInAnonymously" -> synchronized(lock) {
                            authStateSubId.get()?.let { sId ->
                                transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":$anonJson}""")
                            }
                            idTokenSubId.get()?.let { sId ->
                                transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":$anonJson}""")
                            }
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":$anonJson,"operationType":"signIn","additionalUserInfo":{"isNewUser":true,"providerId":null}}}"""
                            )
                        }
                    }
                }
            }
        }

        val app = newApp("stale-signout-null-ordering")
        val auth = FirebaseAuth.getInstance(app, bridge)
        awaitCondition { bridge.isConnected && authStateSubId.get() != null && idTokenSubId.get() != null }

        // 1. Establish initial password session (owner-1).
        Tasks.await(auth.signInWithEmailAndPassword("owner@example.com", "OpsPassword!123"), 5, TimeUnit.SECONDS)
        assertEquals("owner-1", auth.currentUser?.uid)

        // 2. Park BOTH subscribeAuthState and subscribeIdToken collectors inside
        // fetchBridgeUserTokenEnrichment so subsequent signOut(null) snapshots queue
        // in their channels and drain AFTER signInAnonymously() completes.
        try {
            holdCollectorFetches.set(true)
            synchronized(lock) {
                transport.sendToClient("""{"type":"worker-snap","subId":"${authStateSubId.get()}","value":$staleProbeJson}""")
                transport.sendToClient("""{"type":"worker-snap","subId":"${idTokenSubId.get()}","value":$ownerJson}""")
            }
            assertTrue(bothCollectorsHeld.await(3, TimeUnit.SECONDS), "Expected both bridge collectors to park on enrichment")

            // 3. Execute signOut() followed immediately by signInAnonymously(), matching
            // AuthLiveHostConformanceTest.kt lines 242-247.
            auth.signOut()
            assertNull(auth.currentUser)

            holdCollectorFetches.set(false)
            val anonResult = Tasks.await(auth.signInAnonymously(), 5, TimeUnit.SECONDS)
            assertEquals("anonymous-kt-repro-1", anonResult.user?.uid)
            assertEquals("anonymous-kt-repro-1", auth.currentUser?.uid)

            // 4. Release the parked collectors so both drain their buffered signOut(null)
            // snapshots AFTER signInAnonymously() already settled.
            releaseHeldCollectors.countDown()
            assertTrue(heldCollectorsFinished.await(3, TimeUnit.SECONDS))
            Thread.sleep(100)
        } finally {
            releaseHeldCollectors.countDown()
        }

        assertEquals(
            "anonymous-kt-repro-1",
            auth.currentUser?.uid,
            "Late-draining signOut null snapshots must not erase a newer signInAnonymously session"
        )
        val activeLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("anonymous-kt-repro-1", activeLens.uid)

        // 5. Verify a genuine server-pushed sign-out arriving AFTER signInAnonymously
        // (higher wireSeq) still clears currentUser and resets effectiveLens to Anon.
        synchronized(lock) {
            transport.sendToClient("""{"type":"worker-snap","subId":"${authStateSubId.get()}","value":null}""")
        }
        awaitCondition { auth.currentUser == null }
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
    }

    @Test
    fun queuedPreSignOutEmbeddedClaimsSnapshotAtCurrentInboundWireSeqDoesNotResurrectUser() {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        val lock = Any()

        val authStateSubId = AtomicReference<String?>(null)
        val idTokenSubId = AtomicReference<String?>(null)
        val holdFirstFetch = AtomicBoolean(true)
        val firstFetchHeld = CountDownLatch(1)
        val releaseFirstFetch = CountDownLatch(1)
        val firstFetchDone = CountDownLatch(1)

        val probeUserJson = """{"uid":"user-probe","email":"probe@example.com","isAnonymous":false}"""
        val embeddedClaimsUserJson =
            """{"uid":"user-embedded","email":"embedded@example.com","isAnonymous":false,"customClaims":{"role":"member"}}"""

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> synchronized(lock) {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    if (sub["target"] == "authState") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        authStateSubId.set(subId)
                    } else if (sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        idTokenSubId.set(subId)
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.getIdTokenResult" -> {
                            if (holdFirstFetch.getAndSet(false)) {
                                firstFetchHeld.countDown()
                                Thread {
                                    releaseFirstFetch.await(5, TimeUnit.SECONDS)
                                    transport.sendToClient(
                                        """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/no-current-user","message":"Signed out"}}"""
                                    )
                                    firstFetchDone.countDown()
                                }.start()
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-embedded","role":"member"}}}"""
                                )
                            }
                        }
                        "auth.signOut" -> {
                            // Withhold worker-res on signOut so inboundWireSeq stays equal to N
                            // (the wireSeq of embeddedClaimsUserJson) while subscribeAuthState drains.
                        }
                    }
                }
            }
        }

        val app = newApp("stale-pre-signout-boundary-wireseq")
        val auth = FirebaseAuth.getInstance(app, bridge)
        awaitCondition { bridge.isConnected && authStateSubId.get() != null && idTokenSubId.get() != null }

        try {
            val subId = authStateSubId.get()!!
            // 1. Park subscribeAuthState inside fetchBridgeUserTokenEnrichment.
            transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":$probeUserJson}""")
            assertTrue(firstFetchHeld.await(3, TimeUnit.SECONDS))

            // 2. Deliver a second non-null authState snapshot WITH embedded customClaims
            // (so fetchEpoch would be null). Its wireSeq == N == currentInboundWireSeq().
            transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":$embeddedClaimsUserJson}""")

            // 3. Call signOut() locally: lastAuthoritativeWireSeq becomes N.
            auth.signOut()
            assertNull(auth.currentUser)
            assertEquals(AuthLens.Anon, auth.getEffectiveLens())

            // 4. Release the held fetch so subscribeAuthState drains embeddedClaimsUserJson
            // at wireSeq == N == lastAuthoritativeWireSeq.
            releaseFirstFetch.countDown()
            assertTrue(firstFetchDone.await(3, TimeUnit.SECONDS))
            Thread.sleep(100)
        } finally {
            releaseFirstFetch.countDown()
        }

        assertNull(auth.currentUser, "Queued pre-signOut snapshot at wireSeq == lastAuthoritativeWireSeq must not resurrect user")
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
    }

    @Test
    fun inMemoryBridgeTransportDeliversEachPreAttachAndConcurrentSendExactlyOnce() {
        repeat(100) {
            val transport = InMemoryBridgeTransport()
            val delivered = CopyOnWriteArrayList<String>()
            val startLatch = CountDownLatch(1)
            val senderDone = CountDownLatch(1)

            val sender = Thread {
                startLatch.await(3, TimeUnit.SECONDS)
                for (idx in 0 until 20) {
                    transport.send("""{"idx":$idx}""")
                }
                senderDone.countDown()
            }
            sender.start()
            transport.send("""{"idx":-1}""")
            startLatch.countDown()
            transport.onServerReceive { raw ->
                delivered.add(raw)
            }
            assertTrue(senderDone.await(3, TimeUnit.SECONDS))
            assertEquals(21, delivered.size)
            assertEquals((-1 until 20).map { """{"idx":$it}""" }.toSet(), delivered.toSet())
        }
    }
}
