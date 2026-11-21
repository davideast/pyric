package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.storage.FirebaseStorage
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalForInheritanceCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

/**
 * `FirebaseAuth.signOut()` is synchronous in the Firebase Android SDK: when it
 * returns, `currentUser` is null and the next request is unauthenticated. Here
 * the host has not answered `auth.signOut` yet, as on a real socket.
 */
class SignOutIsSynchronousTest {
    private val transport = InMemoryBridgeTransport()
    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val withheldSignOuts = CopyOnWriteArrayList<String>()

    private data class Fixtures(
        val app: FirebaseApp,
        val bridge: PyricBridgeClient,
        val auth: FirebaseAuth,
        val firestore: FirebaseFirestore,
        val storage: FirebaseStorage,
        val database: FirebaseDatabase
    )

    private fun start(): Fixtures {
        FirebaseStorage.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        sentOps.clear()
        withheldSignOuts.clear()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    when (op["method"]) {
                        "auth.signInEmail" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-alice","email":"alice@example.com","isAnonymous":false},"operationType":"signIn"}}"""
                        )
                        "auth.signOut" -> withheldSignOuts.add(id)
                        "getDoc" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"a","path":"items/a","exists":false}}"""
                        )
                        "storage.getBytes" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"dataB64":"","contentType":"application/octet-stream","size":0,"generation":"1"}}"""
                        )
                        "rtdb.get" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"exists":false,"value":null}}"""
                        )
                    }
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "sign-out-sync",
            FirebaseOptions.Builder()
                .setProjectId("demo")
                .setApiKey("k")
                .setApplicationId("a")
                .setStorageBucket("demo.appspot.com")
                .build(),
        )
        val bridge = PyricBridgeClient(transport)
        val auth = FirebaseAuth.getInstance(app, bridge)
        val firestore = FirebaseFirestore(bridge, app, "(default)", credentialsProvider = auth)
        val storage = FirebaseStorage.getInstance(app, bridge)
        val database = FirebaseDatabase.getInstance(app, bridge)
        return Fixtures(app, bridge, auth, firestore, storage, database)
    }

    @AfterEach
    fun tearDown() {
        FirebaseStorage.clearInstancesForTest()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun currentUserIsNullAndTheNextRequestIsAnonymousWhenSignOutReturns() {
        val fixtures = start()
        val auth = fixtures.auth
        val firestore = fixtures.firestore
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        assertEquals("user-alice", auth.currentUser?.uid)

        auth.signOut()

        assertNull(auth.currentUser?.uid, "currentUser after signOut() returned")
        firestore.document("items/a").get()
        val deadline = System.currentTimeMillis() + 2_000
        while (sentOps.none { it["method"] == "getDoc" } && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "getDoc" }["actAs"])
    }

    @Test
    fun storageAndDatabaseSeeSignInAndSignOutSynchronouslyWithoutWaitingForBackgroundCollector() = runBlocking {
        val fixtures = start()
        val auth = fixtures.auth
        val storage = fixtures.storage
        val database = fixtures.database

        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))

        val storageSignedInLens = storage.getEffectiveAuthLens()
        val dbSignedInLens = database.getEffectiveAuthLens()
        assertTrue(storageSignedInLens is AuthLens.AsUser && storageSignedInLens.uid == "user-alice")
        assertTrue(dbSignedInLens is AuthLens.AsUser && dbSignedInLens.uid == "user-alice")
        assertEquals(storageSignedInLens, storage.authLensFlow.value)
        assertEquals(dbSignedInLens, database.authLensFlow.value)

        auth.signOut()

        assertEquals(AuthLens.Anon, storage.getEffectiveAuthLens())
        assertEquals(AuthLens.Anon, storage.authLensFlow.value)
        assertEquals(AuthLens.Anon, storage.authLensFlow.first())
        assertEquals(AuthLens.Anon, database.getEffectiveAuthLens())
        assertEquals(AuthLens.Anon, database.authLensFlow.value)
        assertEquals(AuthLens.Anon, database.authLensFlow.first())

        storage.getReference("items/a").getBytes(64L)
        database.getReference("items/a").get()
        val deadline = System.currentTimeMillis() + 2_000
        while (
            (sentOps.none { it["method"] == "storage.getBytes" } || sentOps.none { it["method"] == "rtdb.get" }) &&
            System.currentTimeMillis() < deadline
        ) {
            Thread.sleep(10)
        }
        assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "storage.getBytes" }["actAs"])
        assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "rtdb.get" }["actAs"])
    }

    @Test
    fun explicitLensOverrideAndRemoteLensFallbackResolveSynchronouslyOnStorageAndDatabase() {
        val fixtures = start()
        val auth = fixtures.auth
        val storage = fixtures.storage
        val database = fixtures.database

        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))

        storage.setAuthLens(AuthLens.Admin)
        database.setAuthLens(AuthLens.Admin)
        assertEquals(AuthLens.Admin, storage.getEffectiveAuthLens())
        assertEquals(AuthLens.Admin, database.getEffectiveAuthLens())

        storage.setAuthLens(null)
        database.setAuthLens(null)
        assertTrue((storage.getEffectiveAuthLens() as? AuthLens.AsUser)?.uid == "user-alice")
        assertTrue((database.getEffectiveAuthLens() as? AuthLens.AsUser)?.uid == "user-alice")

        // Remote lens event propagates through shared FirebaseAuth, and signOut() clears it synchronously.
        val remoteMsg = mapOf(
            "type" to "worker-event",
            "event" to "remote-lens",
            "payload" to mapOf("lens" to mapOf("mode" to "admin"))
        )
        transport.sendToClient(JsonCodec.encodeToString(remoteMsg))
        val deadline = System.currentTimeMillis() + 2_000
        while (auth.getEffectiveLens() != AuthLens.Admin && System.currentTimeMillis() < deadline) {
            Thread.sleep(10)
        }
        assertEquals(AuthLens.Admin, storage.getEffectiveAuthLens())
        assertEquals(AuthLens.Admin, database.getEffectiveAuthLens())

        auth.signOut()
        assertEquals(AuthLens.Anon, storage.getEffectiveAuthLens())
        assertEquals(AuthLens.Anon, database.getEffectiveAuthLens())

        // Without a shared FirebaseAuth credentialsProvider, remote-lens still applies and app-session resets it.
        val standaloneDb = FirebaseDatabase(fixtures.bridge, fixtures.app, credentialsProvider = null)
        try {
            val remoteUserMsg = mapOf(
                "type" to "worker-event",
                "event" to "remote-lens",
                "payload" to mapOf("lens" to mapOf("mode" to "as", "uid" to "studio-user"))
            )
            transport.sendToClient(JsonCodec.encodeToString(remoteUserMsg))
            val standaloneDeadline = System.currentTimeMillis() + 2_000
            while (standaloneDb.getEffectiveAuthLens() !is AuthLens.AsUser && System.currentTimeMillis() < standaloneDeadline) {
                Thread.sleep(10)
            }
            assertEquals("studio-user", (standaloneDb.getEffectiveAuthLens() as AuthLens.AsUser).uid)

            val resetMsg = mapOf(
                "type" to "worker-event",
                "event" to "remote-lens",
                "payload" to mapOf("lens" to mapOf("mode" to "app-session"))
            )
            transport.sendToClient(JsonCodec.encodeToString(resetMsg))
            val resetDeadline = System.currentTimeMillis() + 2_000
            while (standaloneDb.getEffectiveAuthLens() != AuthLens.Anon && System.currentTimeMillis() < resetDeadline) {
                Thread.sleep(10)
            }
            assertEquals(AuthLens.Anon, standaloneDb.getEffectiveAuthLens())
        } finally {
            standaloneDb.databaseScope.cancel()
        }
    }

    @Test
    fun storageAndDatabaseReadCredentialsSynchronouslyEvenBeforeFlowCollectorsRun() {
        val fixtures = start()
        val stalled = StalledFlowCredentialsProvider(AuthLens.AsUser("user-alice"))
        val storage = FirebaseStorage.getInstance(
            app = fixtures.app,
            bridgeClient = fixtures.bridge,
            url = "gs://stalled-bucket",
            credentialsProvider = stalled
        )
        val database = FirebaseDatabase(
            bridgeClient = fixtures.bridge,
            app = fixtures.app,
            credentialsProvider = stalled
        )
        try {
            assertEquals(AuthLens.AsUser("user-alice"), storage.getEffectiveAuthLens())
            assertEquals(AuthLens.AsUser("user-alice"), database.getEffectiveAuthLens())

            // Simulate signOut updating getEffectiveLens() before any background flow collector resumes.
            stalled.current.set(AuthLens.Anon)

            assertEquals(AuthLens.Anon, storage.getEffectiveAuthLens())
            assertEquals(AuthLens.Anon, storage.authLensFlow.value)
            assertEquals(AuthLens.Anon, database.getEffectiveAuthLens())
            assertEquals(AuthLens.Anon, database.authLensFlow.value)

            storage.getReference("items/a").getBytes(64L)
            database.getReference("items/a").get()
            val deadline = System.currentTimeMillis() + 2_000
            while (
                (sentOps.none { it["method"] == "storage.getBytes" } || sentOps.none { it["method"] == "rtdb.get" }) &&
                System.currentTimeMillis() < deadline
            ) {
                Thread.sleep(10)
            }
            assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "storage.getBytes" }["actAs"])
            assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "rtdb.get" }["actAs"])
        } finally {
            database.databaseScope.cancel()
            stalled.release.complete(Unit)
        }
    }

    @OptIn(ExperimentalForInheritanceCoroutinesApi::class)
    private class StalledFlowCredentialsProvider(initial: AuthLens) : CredentialsProvider {
        val current = AtomicReference(initial)
        val release = CompletableDeferred<Unit>()

        override fun getEffectiveLens(): AuthLens = current.get()

        override val authLensFlow: StateFlow<AuthLens> = object : StateFlow<AuthLens> {
            override val value: AuthLens get() = current.get()
            override val replayCache: List<AuthLens> get() = listOf(current.get())
            override suspend fun collect(collector: FlowCollector<AuthLens>): Nothing {
                release.await()
                awaitCancellation()
            }
        }
    }
}
