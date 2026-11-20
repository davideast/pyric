package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.database.DataSnapshot
import dev.pyric.database.DatabaseError
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ValueEventListener
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class LiveHostConformanceTest {
    private var bridgeClient: PyricBridgeClient? = null
    private var app: FirebaseApp? = null

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping live-host Kotlin conformance test"
        )
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        val initializedApp = FirebaseApp.initializeApp(
            "kotlin-live-host-app",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.test")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        app = initializedApp
        bridgeClient = PyricBridgeClient(url = envUrl)
    }

    @AfterEach
    fun tearDown() {
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        bridgeClient = null
        app = null
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `authenticates email-password and anonymous sessions end-to-end against live host`() {
        val activeApp = requireNotNull(app)
        val bridge = requireNotNull(bridgeClient)
        val auth = FirebaseAuth.getInstance(activeApp, bridge)
        val mainDb = FirebaseDatabase.getInstance(activeApp, bridge)

        val observedUids = CopyOnWriteArrayList<String?>()
        val authListener = FirebaseAuth.AuthStateListener { instance ->
            observedUids.add(instance.currentUser?.uid)
        }
        auth.addAuthStateListener(authListener)

        try {
            val email = "member-${System.nanoTime()}@example.com"
            val password = "LiveHostPassword!123"
            val created = Tasks.await(
                auth.createUserWithEmailAndPassword(email, password),
                10,
                TimeUnit.SECONDS
            )
            val createdUser = requireNotNull(created.user)
            val ownerUid = createdUser.uid
            assertTrue(ownerUid.isNotBlank())
            assertFalse(createdUser.isAnonymous)
            assertEquals(email, createdUser.email)
            assertEquals(ownerUid, auth.currentUser?.uid)
            assertTrue(observedUids.contains(ownerUid))

            val initialTokenResult = Tasks.await(createdUser.getIdToken(false), 10, TimeUnit.SECONDS)
            assertNotNull(initialTokenResult)
            assertEquals(3, initialTokenResult.token.split('.').size)

            val refreshedTokenResult = Tasks.await(createdUser.getIdToken(true), 10, TimeUnit.SECONDS)
            assertNotNull(refreshedTokenResult)
            assertEquals(3, refreshedTokenResult.token.split('.').size)

            val tokenResult = Tasks.await(createdUser.getIdTokenResult(false), 10, TimeUnit.SECONDS)
            assertEquals("password", tokenResult.signInProvider)
            assertEquals(email, tokenResult.claims["email"])

            Tasks.await(
                mainDb.getReference("profiles/$ownerUid").setValue(mapOf("displayName" to "Member")),
                10,
                TimeUnit.SECONDS
            )
            val profileSnap = Tasks.await(
                mainDb.getReference("profiles/$ownerUid").get(),
                10,
                TimeUnit.SECONDS
            )
            assertTrue(profileSnap.exists())
            assertEquals("Member", profileSnap.child("displayName").value)

            auth.signOut()
            assertNull(auth.currentUser)
            assertPermissionDenied {
                Tasks.await(
                    mainDb.getReference("profiles/$ownerUid").setValue(mapOf("displayName" to "SignedOut")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            val reSignedIn = Tasks.await(
                auth.signInWithEmailAndPassword(email, password),
                10,
                TimeUnit.SECONDS
            )
            assertEquals(ownerUid, reSignedIn.user?.uid)

            auth.signOut()
            val anonResult = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
            val anonUser = requireNotNull(anonResult.user)
            assertTrue(anonUser.isAnonymous)
            assertNull(anonUser.email)
            assertNotEquals(ownerUid, anonUser.uid)

            Tasks.await(
                mainDb.getReference("profiles/${anonUser.uid}").setValue(mapOf("guest" to true)),
                10,
                TimeUnit.SECONDS
            )
            assertPermissionDenied {
                Tasks.await(
                    mainDb.getReference("profiles/$ownerUid").setValue(mapOf("hijack" to true)),
                    10,
                    TimeUnit.SECONDS
                )
            }
        } finally {
            auth.removeAuthStateListener(authListener)
        }
    }

    @Test
    fun `isolates multi-instance RTDB reads, writes, listeners, and per-shard rules`() {
        val activeApp = requireNotNull(app)
        val bridge = requireNotNull(bridgeClient)
        val auth = FirebaseAuth.getInstance(activeApp, bridge)

        val email = "sharded-${System.nanoTime()}@example.com"
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(email, "ShardPass!123"),
            10,
            TimeUnit.SECONDS
        )
        val uid = requireNotNull(created.user).uid

        val mainDb = FirebaseDatabase.getInstance(activeApp, bridge)
        val shard00 = FirebaseDatabase.getInstance(
            activeApp,
            bridge,
            "https://$PROJECT_ID-shard-00.firebaseio.com"
        )
        val shard01 = FirebaseDatabase.getInstance(
            activeApp,
            bridge,
            "https://$PROJECT_ID-shard-01.firebaseio.com"
        )
        val shard09 = FirebaseDatabase.getInstance(
            activeApp,
            bridge,
            "https://$PROJECT_ID-shard-09.firebaseio.com"
        )

        val memberPath = "rooms/r1/members/$uid"
        val liveValue = AtomicReference<Map<*, *>?>(null)
        val valueDelivered = CountDownLatch(1)
        val listener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val mapVal = snapshot.value as? Map<*, *>
                if (mapVal != null && mapVal["role"] == "host") {
                    liveValue.set(mapVal)
                    valueDelivered.countDown()
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        }
        shard00.getReference(memberPath).addValueEventListener(listener)

        try {
            Tasks.await(
                shard00.getReference(memberPath).setValue(mapOf("role" to "host", "ready" to true)),
                10,
                TimeUnit.SECONDS
            )
            assertTrue(
                valueDelivered.await(10, TimeUnit.SECONDS),
                "Expected live ValueEventListener delivery on shard-00"
            )
            assertEquals("host", liveValue.get()?.get("role"))
            assertEquals(true, liveValue.get()?.get("ready"))

            val shard00Snap = Tasks.await(shard00.getReference(memberPath).get(), 10, TimeUnit.SECONDS)
            assertTrue(shard00Snap.exists())
            assertEquals("host", shard00Snap.child("role").value)

            // Same path on shard-01 is denied by shard-01's independent ruleset.
            assertPermissionDenied {
                Tasks.await(
                    shard01.getReference(memberPath).setValue(mapOf("role" to "denied")),
                    10,
                    TimeUnit.SECONDS
                )
            }
            assertPermissionDenied {
                Tasks.await(shard01.getReference(memberPath).get(), 10, TimeUnit.SECONDS)
            }

            val cancelledError = AtomicReference<DatabaseError?>(null)
            val cancelLatch = CountDownLatch(1)
            shard01.getReference(memberPath).addListenerForSingleValueEvent(object : ValueEventListener {
                override fun onDataChange(snapshot: DataSnapshot) {}
                override fun onCancelled(error: DatabaseError) {
                    cancelledError.set(error)
                    cancelLatch.countDown()
                }
            })
            assertTrue(
                cancelLatch.await(10, TimeUnit.SECONDS),
                "Expected ValueEventListener onCancelled for denied read on shard-01"
            )
            assertEquals(DatabaseError.PERMISSION_DENIED, cancelledError.get()?.code)

            // Cross-UID write on shard-00 is denied.
            assertPermissionDenied {
                Tasks.await(
                    shard00.getReference("rooms/r1/members/another-user").setValue(mapOf("role" to "spoof")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            // shard-01 permits audit/<uid>, while shard-00 and main deny audit/<uid>.
            Tasks.await(
                shard01.getReference("audit/$uid").setValue(mapOf("event" to "verified")),
                10,
                TimeUnit.SECONDS
            )
            val auditSnap = Tasks.await(shard01.getReference("audit/$uid").get(), 10, TimeUnit.SECONDS)
            assertEquals("verified", auditSnap.child("event").value)

            assertPermissionDenied {
                Tasks.await(
                    shard00.getReference("audit/$uid").setValue(mapOf("event" to "wrong-shard")),
                    10,
                    TimeUnit.SECONDS
                )
            }
            assertPermissionDenied {
                Tasks.await(
                    mainDb.getReference("audit/$uid").setValue(mapOf("event" to "wrong-main")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            // shard-09 permits only shards/shard-09/<uid>, isolating all 10 named shards.
            Tasks.await(
                shard09.getReference("shards/shard-09/$uid").setValue(mapOf("index" to 9L)),
                10,
                TimeUnit.SECONDS
            )
            val shard09Snap = Tasks.await(
                shard09.getReference("shards/shard-09/$uid").get(),
                10,
                TimeUnit.SECONDS
            )
            assertEquals(9L, (shard09Snap.child("index").value as? Number)?.toLong())

            assertPermissionDenied {
                Tasks.await(
                    shard09.getReference("shards/shard-02/$uid").setValue(mapOf("index" to 2L)),
                    10,
                    TimeUnit.SECONDS
                )
            }
        } finally {
            shard00.getReference(memberPath).removeEventListener(listener)
        }
    }

    private fun assertPermissionDenied(block: () -> Unit) {
        try {
            block()
            throw AssertionError("Expected PERMISSION_DENIED failure, but operation succeeded")
        } catch (err: ExecutionException) {
            val cause = err.cause ?: err
            val dbError = DatabaseError.fromException(cause)
            assertEquals(
                DatabaseError.PERMISSION_DENIED,
                dbError.code,
                "Expected PERMISSION_DENIED (-3), got ${dbError.code}: ${cause.message}"
            )
        }
    }

    companion object {
        private const val PROJECT_ID = "demo-kotlin-live"
    }
}
