package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseException
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ValueEventListener
import com.google.firebase.database.database
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
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
        val mainDb = FirebaseDatabase.getInstance(activeApp)
        assertSame(bridge, mainDb.bridgeClient)

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
    fun `isolates 11-shard RTDB reads, writes, listeners, shared Auth, and forced token refresh`() {
        val activeApp = requireNotNull(app)
        val bridge = requireNotNull(bridgeClient)
        val auth = FirebaseAuth.getInstance(activeApp, bridge)

        val email = "sharded-${System.nanoTime()}@example.com"
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(email, "ShardPass!123"),
            10,
            TimeUnit.SECONDS
        )
        val user = requireNotNull(created.user)
        val uid = user.uid

        // Resolve default + all 10 named shards via standard public FirebaseDatabase APIs (no bridge arg).
        val mainDb = Firebase.database(activeApp)
        val shards = (0..9).map { idx ->
            val shardTag = "shard-0$idx"
            val shardUrl = "https://$PROJECT_ID-$shardTag.firebaseio.com"
            val handle = FirebaseDatabase.getInstance(activeApp, shardUrl)
            assertSame(bridge, handle.bridgeClient, "Expected $shardTag to share app bridge socket")
            assertEquals(shardUrl, handle.url)
            assertSame(handle, Firebase.database(activeApp, shardUrl))
            handle
        }
        assertSame(bridge, mainDb.bridgeClient)

        val shard00 = shards[0]
        val shard01 = shards[1]

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

            // Same path on main does not see shard-00 data (data isolation) and is denied by main rules.
            assertPermissionDenied {
                Tasks.await(mainDb.getReference(memberPath).get(), 10, TimeUnit.SECONDS)
            }

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

            // Force ID token refresh on the shared Auth session and verify default + shard-02..shard-09 isolation.
            val refreshed = Tasks.await(user.getIdToken(true), 10, TimeUnit.SECONDS)
            assertEquals(3, refreshed.token.split('.').size)

            Tasks.await(
                mainDb.getReference("profiles/$uid").setValue(mapOf("shardCount" to 11L)),
                10,
                TimeUnit.SECONDS
            )
            assertEquals(
                11L,
                Tasks.await(mainDb.getReference("profiles/$uid/shardCount").get(), 10, TimeUnit.SECONDS)
                    .getValue(Long::class.java)
            )

            for (idx in 2..9) {
                val shardTag = "shard-0$idx"
                val shardDb = shards[idx]
                val allowedPath = "shards/$shardTag/$uid"
                Tasks.await(
                    shardDb.getReference(allowedPath).setValue(mapOf("index" to idx.toLong())),
                    10,
                    TimeUnit.SECONDS
                )
                val snap = Tasks.await(shardDb.getReference(allowedPath).get(), 10, TimeUnit.SECONDS)
                assertTrue(snap.exists(), "Expected $shardTag to store data at $allowedPath")
                assertEquals(idx.toLong(), snap.child("index").getValue(Long::class.java))

                val neighborIdx = if (idx == 9) 2 else idx + 1
                val neighborPath = "shards/shard-0$neighborIdx/$uid"
                assertPermissionDenied {
                    Tasks.await(
                        shardDb.getReference(neighborPath).setValue(mapOf("index" to neighborIdx.toLong())),
                        10,
                        TimeUnit.SECONDS
                    )
                }
                assertPermissionDenied {
                    Tasks.await(shardDb.getReference(neighborPath).get(), 10, TimeUnit.SECONDS)
                }
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
            assertTrue(
                cause is DatabaseException,
                "Expected com.google.firebase.database.DatabaseException, got ${cause.javaClass.name}: ${cause.message}"
            )
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
