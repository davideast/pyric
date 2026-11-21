package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.OAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
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
import java.util.concurrent.atomic.AtomicReference

/**
 * Verifies that `FirebaseAuth` enriches custom claims from `auth.getIdTokenResult`
 * before publishing a bridge `authState` transition to `currentUser` and `authLensFlow`,
 * matching the real Node host wire sequence where `authState` and `idToken` snapshots
 * omit `customClaims` and arrive ahead of the sign-in RPC response.
 */
class AuthBridgeClaimsEnrichmentTest {

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
    fun bridgeAuthStateBeforeSignInReplyNeverEmitsClaimslessLensOrKillsSnapshotListener() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        val lock = Any()

        var authStateSubId: String? = null
        var idTokenSubId: String? = null
        val activeItemSubId = AtomicReference<String?>(null)
        val itemSubActAs = CopyOnWriteArrayList<Map<String, Any?>>()
        val releaseSignInReply = CountDownLatch(1)
        val sawItemResubOrDeny = CountDownLatch(1)
        val sawEnrichTokenFetch = CountDownLatch(1)

        val userJson = """{"uid":"user-1","email":"member@example.com","displayName":"Member","emailVerified":true,"isAnonymous":false,"providerId":"firebase","tenantId":"tenant-1","providerData":[{"uid":"user-1","email":"member@example.com","providerId":"github.com"}]}"""

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> synchronized(lock) {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    val target = sub["target"]
                    if (target == "authState") {
                        authStateSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        return@synchronized
                    }
                    if (target == "idToken") {
                        idTokenSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        return@synchronized
                    }
                    @Suppress("UNCHECKED_CAST")
                    val actAs = sub["actAs"] as? Map<String, Any?> ?: emptyMap()
                    itemSubActAs.add(actAs)
                    val mode = actAs["mode"] as? String
                    @Suppress("UNCHECKED_CAST")
                    val token = actAs["token"] as? Map<String, Any?>
                    val allowed = mode == "anon" || (mode == "as" && token?.get("role") == "member")
                    if (!allowed) {
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"__error":{"code":"permission-denied","message":"get items/item-1 denied by rules"}}}"""
                        )
                        sawItemResubOrDeny.countDown()
                    } else {
                        activeItemSubId.set(subId)
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"id":"item-1","path":"items/item-1","exists":false}}"""
                        )
                        if (mode == "as") {
                            sawItemResubOrDeny.countDown()
                        }
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.signInWithCredential" -> {
                            // Mirror real Node host ordering: authState + idToken snaps
                            // (without customClaims) go out before worker-res.
                            synchronized(lock) {
                                authStateSubId?.let { sId ->
                                    transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":$userJson}""")
                                }
                                idTokenSubId?.let { sId ->
                                    transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":$userJson}""")
                                }
                            }
                            // Hold the sign-in RPC reply slightly on a background thread so
                            // subscribeAuthState always runs first, making the race deterministic.
                            Thread {
                                releaseSignInReply.await(300, TimeUnit.MILLISECONDS)
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":$userJson,"providerId":"github.com","operationType":"signIn","additionalUserInfo":{"isNewUser":true,"providerId":"github.com"}}}"""
                                )
                            }.start()
                        }
                        "auth.getIdTokenResult" -> {
                            sawEnrichTokenFetch.countDown()
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"header.payload.sig","claims":{"sub":"user-1","user_id":"user-1","role":"member","firebase":{"sign_in_provider":"github.com"}},"signInProvider":"github.com"}}"""
                            )
                        }
                    }
                }
            }
        }

        val app = newApp("bridge-claims-enrichment")
        val auth = FirebaseAuth.getInstance(app, bridge)
        val firestore = FirebaseFirestore(bridge, app, "(default)", credentialsProvider = auth)
        val collectorScope = CoroutineScope(Dispatchers.IO)

        val observedLenses = CopyOnWriteArrayList<AuthLens>()
        val snapshots = CopyOnWriteArrayList<Pair<Boolean, Any?>>()
        val errors = CopyOnWriteArrayList<Throwable>()

        val lensJob = collectorScope.launch {
            auth.authLensFlow.collect { observedLenses.add(it) }
        }
        val snapJob = collectorScope.launch {
            firestore.document("items/item-1").snapshots()
                .catch { e -> errors.add(e) }
                .collect { snap -> snapshots.add(snap.exists() to snap.get("status")) }
        }

        try {
            awaitCondition {
                observedLenses.contains(AuthLens.Anon) &&
                    snapshots.isNotEmpty() &&
                    authStateSubId != null &&
                    idTokenSubId != null
            }

            auth.tenantId = "tenant-1"
            val cred = OAuthProvider.getCredential("github.com", "id-tok", "acc-tok")
            val signInTask = auth.signInWithCredential(cred)

            assertTrue(
                sawEnrichTokenFetch.await(3, TimeUnit.SECONDS),
                "Expected auth.getIdTokenResult claims fetch before publishing bridge authState"
            )
            assertTrue(
                sawItemResubOrDeny.await(3, TimeUnit.SECONDS),
                "Expected active snapshot listener to re-subscribe after bridge authState"
            )
            releaseSignInReply.countDown()
            Tasks.await(signInTask, 5, TimeUnit.SECONDS)

            assertTrue(errors.isEmpty(), "Snapshot listener must not receive PERMISSION_DENIED, got: $errors")
            val asUserLenses = observedLenses.filterIsInstance<AuthLens.AsUser>()
            assertTrue(asUserLenses.isNotEmpty(), "Expected at least one AuthLens.AsUser transition")
            assertTrue(
                asUserLenses.all { it.token?.get("role") == "member" },
                "Every AuthLens.AsUser must carry role=member, observed: $asUserLenses"
            )
            val asUserSubs = itemSubActAs.filter { it["mode"] == "as" }
            assertTrue(asUserSubs.isNotEmpty(), "Expected re-subscription with mode=as")
            assertTrue(
                asUserSubs.all { (it["token"] as? Map<*, *>)?.get("role") == "member" },
                "Every authenticated subscription must carry role=member, sent: $asUserSubs"
            )

            // Confirm the listener stayed alive and delivers subsequent updates.
            val currentSubId = activeItemSubId.get()
            assertTrue(currentSubId != null, "Expected active item subscription id")
            transport.sendToClient(
                """{"type":"worker-snap","subId":"$currentSubId","value":{"id":"item-1","path":"items/item-1","exists":true,"data":{"json":"{\"status\":\"ready\"}"}}}"""
            )
            awaitCondition { snapshots.any { it.first && it.second == "ready" } }
        } finally {
            snapJob.cancel()
            lensJob.cancel()
            collectorScope.cancel()
        }
    }

    @Test
    fun signOutDuringInFlightBridgeClaimsFetchDoesNotResurrectUser() {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        var authStateSubId: String? = null
        val tokenFetchStarted = CountDownLatch(1)
        val releaseTokenFetch = CountDownLatch(1)
        val tokenFetchReplied = CountDownLatch(1)

        val userJson = """{"uid":"user-1","email":"member@example.com","isAnonymous":false}"""

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    if (sub["target"] == "authState") {
                        authStateSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    } else if (sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.getIdTokenResult" -> {
                            tokenFetchStarted.countDown()
                            Thread {
                                releaseTokenFetch.await(5, TimeUnit.SECONDS)
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-1","role":"member"},"signInProvider":"password"}}"""
                                )
                                tokenFetchReplied.countDown()
                            }.start()
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
            }
        }

        val app = newApp("signout-during-claims-fetch")
        val auth = FirebaseAuth.getInstance(app, bridge)

        awaitCondition { authStateSubId != null }
        transport.sendToClient("""{"type":"worker-snap","subId":"$authStateSubId","value":$userJson}""")
        assertTrue(tokenFetchStarted.await(3, TimeUnit.SECONDS), "Expected auth.getIdTokenResult for claims enrichment")

        // Synchronous signOut while bridge claims enrichment is still in flight.
        auth.signOut()
        assertNull(auth.currentUser)
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())

        // Release the stale token fetch reply and confirm it does not resurrect user-1.
        releaseTokenFetch.countDown()
        assertTrue(tokenFetchReplied.await(3, TimeUnit.SECONDS))
        Thread.sleep(100)

        assertNull(auth.currentUser, "Stale bridge authState must not resurrect signed-out user")
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
    }

    @Test
    fun mismatchedSubjectAndNoCurrentUserDropStaleBridgeAuthState() {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        var authStateSubId: String? = null
        var tokenResponseMode = "mismatch"
        val firstFetchDone = CountDownLatch(1)
        val secondFetchDone = CountDownLatch(1)

        val user1Json = """{"uid":"user-1","email":"one@example.com","isAnonymous":false}"""
        val user2Json = """{"uid":"user-2","email":"two@example.com","isAnonymous":false}"""

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    if (sub["target"] == "authState") {
                        authStateSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    } else if (sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    if (op["method"] == "auth.getIdTokenResult") {
                        when (tokenResponseMode) {
                            "mismatch" -> {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-2","role":"admin"}}}"""
                                )
                                firstFetchDone.countDown()
                            }
                            "no-user" -> {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/no-current-user","message":"getIdTokenResult: no current user is signed in."}}"""
                                )
                                secondFetchDone.countDown()
                            }
                            else -> {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-2","role":"member"}}}"""
                                )
                            }
                        }
                    }
                }
            }
        }

        val app = newApp("stale-subject-and-no-user")
        val auth = FirebaseAuth.getInstance(app, bridge)
        awaitCondition { authStateSubId != null }

        // 1. Mismatched sub -> stale user-1 snapshot is dropped.
        transport.sendToClient("""{"type":"worker-snap","subId":"$authStateSubId","value":$user1Json}""")
        assertTrue(firstFetchDone.await(3, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertNull(auth.currentUser)
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())

        // 2. auth/no-current-user -> stale user-1 snapshot is dropped.
        tokenResponseMode = "no-user"
        transport.sendToClient("""{"type":"worker-snap","subId":"$authStateSubId","value":$user1Json}""")
        assertTrue(secondFetchDone.await(3, TimeUnit.SECONDS))
        Thread.sleep(100)
        assertNull(auth.currentUser)
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())

        // 3. Matching user-2 succeeds with full claims.
        tokenResponseMode = "ok"
        transport.sendToClient("""{"type":"worker-snap","subId":"$authStateSubId","value":$user2Json}""")
        awaitCondition { auth.currentUser?.uid == "user-2" }
        val lens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("user-2", lens.uid)
        assertEquals("member", lens.token?.get("role"))
    }

    @Test
    fun idTokenSnapshotDoesNotApplyClaimsAfterSignOutOrEmitSpuriousNullBeforeSignIn() {
        val transport = InMemoryBridgeTransport()
        val bridge = PyricBridgeClient(transport)
        var idTokenSubId: String? = null
        val idTokenFetchStarted = CountDownLatch(1)
        val releaseIdTokenFetch = CountDownLatch(1)
        val idTokenFetchReplied = CountDownLatch(1)
        var allowTokenFetchHold = false

        val userJson = """{"uid":"user-1","email":"member@example.com","isAnonymous":false}"""

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
                    } else if (sub["target"] == "idToken") {
                        idTokenSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"]) {
                        "auth.signInEmail" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":$userJson,"providerId":"password","operationType":"signIn","claims":{"sub":"user-1","role":"member"}}}"""
                            )
                        }
                        "auth.getIdTokenResult" -> {
                            if (allowTokenFetchHold) {
                                idTokenFetchStarted.countDown()
                                Thread {
                                    releaseIdTokenFetch.await(5, TimeUnit.SECONDS)
                                    transport.sendToClient(
                                        """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-1","role":"admin"},"signInProvider":"password"}}"""
                                    )
                                    idTokenFetchReplied.countDown()
                                }.start()
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"tok","claims":{"sub":"user-1","role":"member"},"signInProvider":"password"}}"""
                                )
                            }
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
            }
        }

        val app = newApp("idtoken-snapshot-races")
        val auth = FirebaseAuth.getInstance(app, bridge)
        val observedIdTokenUids = CopyOnWriteArrayList<String?>()
        val listener = FirebaseAuth.IdTokenListener { a -> observedIdTokenUids.add(a.currentUser?.uid) }
        auth.addIdTokenListener(listener)

        try {
            awaitCondition { idTokenSubId != null }
            assertEquals(listOf<String?>(null), observedIdTokenUids.toList())

            // A non-null idToken snapshot arriving before currentUser is set must not emit a spurious null.
            transport.sendToClient("""{"type":"worker-snap","subId":"$idTokenSubId","value":$userJson}""")
            Thread.sleep(80)
            assertEquals(listOf<String?>(null), observedIdTokenUids.toList())

            // Sign in, then start an idToken snapshot whose getIdTokenResult is held across signOut().
            Tasks.await(auth.signInWithEmailAndPassword("member@example.com", "secret"), 5, TimeUnit.SECONDS)
            assertEquals("user-1", auth.currentUser?.uid)

            allowTokenFetchHold = true
            transport.sendToClient("""{"type":"worker-snap","subId":"$idTokenSubId","value":$userJson}""")
            assertTrue(idTokenFetchStarted.await(3, TimeUnit.SECONDS))

            auth.signOut()
            val countAfterSignOut = observedIdTokenUids.size
            assertNull(auth.currentUser)
            assertEquals(AuthLens.Anon, auth.getEffectiveLens())

            releaseIdTokenFetch.countDown()
            assertTrue(idTokenFetchReplied.await(3, TimeUnit.SECONDS))
            Thread.sleep(100)

            assertNull(auth.currentUser)
            assertEquals(AuthLens.Anon, auth.getEffectiveLens())
            assertEquals(countAfterSignOut, observedIdTokenUids.size, "Stale idToken refresh must not notify after signOut")
        } finally {
            auth.removeIdTokenListener(listener)
        }
    }
}
