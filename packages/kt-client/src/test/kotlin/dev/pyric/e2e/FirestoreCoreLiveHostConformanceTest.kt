package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.ServerTimestamp
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.TransactionOptions
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.firestoreSettings
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.Date
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FirestoreCoreLiveHostConformanceTest {
    data class CatalogItem(
        @DocumentId
        var id: String? = null,
        var title: String? = null,
        var quantity: Long? = null,
        @ServerTimestamp
        var createdAt: Timestamp? = null
    )

    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var uid: String

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_FIRESTORE_BRIDGE_URL")
            ?: System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_FIRESTORE_BRIDGE_URL is unset; skipping live-host Kotlin Firestore core conformance test"
        )
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        liveBridgeUrl = envUrl
        projectId = System.getenv("PYRIC_LIVE_FIRESTORE_PROJECT_ID") ?: DEFAULT_PROJECT_ID
        app = FirebaseApp.initializeApp(
            FirebaseOptions.Builder()
                .setProjectId(projectId)
                .setApiKey("demo-firestore-api-key")
                .setApplicationId("1:424242424242:android:kotlinfirestore")
                .build()
        )
        val client = PyricBridgeClient(url = envUrl)
        bridgeClient = client
        auth = FirebaseAuth.getInstance(app, client)
        firestore = FirebaseFirestore.getInstance(app, client)

        val email = "fs-core-${System.nanoTime()}@example.com"
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(email, USER_PASSWORD),
            10,
            TimeUnit.SECONDS
        )
        uid = requireNotNull(created.user).uid
    }

    @AfterEach
    fun tearDown() {
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        bridgeClient = null
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("proves instance caching, firestoreSettings lifecycle lock, and path reference validation (#1, #3, #4, #5)")
    fun `proves instance caching, firestoreSettings lifecycle lock, and path reference validation`() {
        assertSame(firestore, FirebaseFirestore.getInstance())
        assertSame(firestore, FirebaseFirestore.getInstance(app))
        assertSame(firestore, Firebase.firestore)
        assertSame(firestore, Firebase.firestore(app))
        assertEquals("(default)", firestore.databaseId)

        val secondaryClient = PyricBridgeClient(url = liveBridgeUrl)
        try {
            val secondaryApp = FirebaseApp.initializeApp(
                "secondary-fs-app",
                FirebaseOptions.Builder()
                    .setProjectId(projectId)
                    .setApiKey("secondary-api-key")
                    .setApplicationId("1:424242424242:android:secondary")
                    .build()
            )
            val secondaryFs = FirebaseFirestore.getInstance(secondaryApp, secondaryClient)
            assertNotSame(firestore, secondaryFs)
            assertSame(secondaryFs, Firebase.firestore(secondaryApp))

            assertThrows(IllegalArgumentException::class.java) {
                firestoreSettings { setCacheSizeBytes(1024L) }
            }
            assertThrows(IllegalArgumentException::class.java) {
                firestoreSettings { setHost("   ") }
            }

            val configured = firestoreSettings {
                setHost("127.0.0.1:8085")
                setSslEnabled(false)
                setPersistenceEnabled(false)
                setCacheSizeBytes(2L * 1024L * 1024L)
            }
            secondaryFs.firestoreSettings = configured
            assertEquals(configured, secondaryFs.firestoreSettings)
            val copied = FirebaseFirestoreSettings.Builder(configured).build()
            assertEquals(configured, copied)

            val customSettings = firestoreSettings {
                setHost("127.0.0.1:9090")
                setSslEnabled(true)
                setPersistenceEnabled(true)
                setCacheSizeBytes(FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED)
            }
            firestore.firestoreSettings = customSettings
            assertEquals(customSettings, firestore.firestoreSettings)

            // Starting an operation locks firestoreSettings against unequal mutation
            val ownerDoc = firestore.document("/users/$uid/")
            assertEquals("users/$uid", ownerDoc.path)
            assertEquals(uid, ownerDoc.id)
            assertEquals("users", ownerDoc.parent.path)
            Tasks.await(ownerDoc.set(mapOf("status" to "active")), 10, TimeUnit.SECONDS)

            // Assigning equal settings after start is allowed; unequal settings throws IllegalStateException
            firestore.firestoreSettings = FirebaseFirestoreSettings.Builder(customSettings).build()
            assertThrows(IllegalStateException::class.java) {
                firestore.firestoreSettings = configured
            }

            val itemsCol = firestore.collection("/users/$uid/items/")
            assertEquals("users/$uid/items", itemsCol.path)
            assertEquals("items", itemsCol.id)
            assertEquals("users/$uid", itemsCol.parent?.path)

            assertThrows(IllegalArgumentException::class.java) { firestore.document("") }
            assertThrows(IllegalArgumentException::class.java) { firestore.document("///") }
            assertThrows(IllegalArgumentException::class.java) { firestore.document("users") }
            assertThrows(IllegalArgumentException::class.java) { firestore.document("users/$uid/items") }
            assertThrows(IllegalArgumentException::class.java) { firestore.collection("") }
            assertThrows(IllegalArgumentException::class.java) { firestore.collection("users/$uid") }
        } finally {
            runBlocking { secondaryClient.disconnect() }
        }
    }

    @Test
    @DisplayName("proves collectionGroup queries across hierarchies, batch atomicity, and transaction retries (#6, #7, #8)")
    fun `proves collectionGroup queries across hierarchies, batch atomicity, and transaction retries`() {
        assertEquals("", firestore.collectionGroup("").collectionId)
        assertThrows(IllegalArgumentException::class.java) { firestore.collectionGroup("users/items") }

        // Standard user without moderator claim is denied collectionGroup("items") read by Security Rules
        assertPermissionDenied {
            Tasks.await(firestore.collectionGroup("items").get(), 10, TimeUnit.SECONDS)
        }

        val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        val signedIn = Tasks.await(auth.signInWithCustomToken(moderatorToken), 10, TimeUnit.SECONDS)
        val modUid = requireNotNull(signedIn.user).uid

        val tagKey = "cg-${System.nanoTime()}"
        val userItemRef = firestore.document("users/$modUid/items/u-item-1")
        val roleItemRef = firestore.document("role_items/moderator/items/r-item-1")

        // Atomic batch commit across user subcollection and role subcollection
        val seedBatch = firestore.batch()
        seedBatch.set(userItemRef, mapOf("groupTag" to tagKey, "rank" to 1L))
        seedBatch.set(roleItemRef, mapOf("groupTag" to tagKey, "rank" to 2L))
        Tasks.await(seedBatch.commit(), 10, TimeUnit.SECONDS)
        assertThrows(IllegalStateException::class.java) { seedBatch.commit() }

        // collectionGroup("items") spans both /users/{uid}/items and /role_items/moderator/items
        val groupSnap = Tasks.await(
            firestore.collectionGroup("items")
                .whereEqualTo("groupTag", tagKey)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(
            setOf("users/$modUid/items/u-item-1", "role_items/moderator/items/r-item-1"),
            groupSnap.documents.map { it.reference.path }.toSet()
        )

        // Batch atomicity under Security Rules: forbidden write aborts entire batch
        val atomicProbeRef = firestore.document("users/$modUid/items/should-not-commit")
        val deniedBatch = firestore.batch()
        deniedBatch.set(atomicProbeRef, mapOf("staged" to true))
        deniedBatch.set(firestore.document("users/other-user/items/forbidden"), mapOf("staged" to true))
        assertPermissionDenied {
            Tasks.await(deniedBatch.commit(), 10, TimeUnit.SECONDS)
        }
        assertFalse(Tasks.await(atomicProbeRef.get(), 10, TimeUnit.SECONDS).exists())

        // Interactive runTransaction with real live-host optimistic concurrency contention & maxAttempts
        val counterRef = firestore.document("users/$modUid")
        Tasks.await(counterRef.set(mapOf("balance" to 50L)), 10, TimeUnit.SECONDS)

        val retryAttempts = AtomicInteger(0)
        val updatedBalance = Tasks.await(
            firestore.runTransaction(
                TransactionOptions.Builder().setMaxAttempts(3).build()
            ) { txn ->
                val attempt = retryAttempts.incrementAndGet()
                val snap = txn.get(counterRef)
                val current = snap.getLong("balance") ?: 0L
                if (attempt == 1) {
                    // Concurrent external write mutates counterRef on live host before txnCommit
                    Tasks.await(counterRef.set(mapOf("balance" to 80L)), 10, TimeUnit.SECONDS)
                }
                val next = current + 25L
                txn.update(counterRef, "balance", next)
                next
            },
            10,
            TimeUnit.SECONDS
        )
        assertEquals(2, retryAttempts.get())
        assertEquals(105L, updatedBalance)
        assertEquals(105L, Tasks.await(counterRef.get(), 10, TimeUnit.SECONDS).getLong("balance"))

        val exhaustedAttempts = AtomicInteger(0)
        try {
            Tasks.await(
                firestore.runTransaction(
                    TransactionOptions.Builder().setMaxAttempts(1).build()
                ) { txn ->
                    exhaustedAttempts.incrementAndGet()
                    val snap = txn.get(counterRef)
                    val current = snap.getLong("balance") ?: 0L
                    Tasks.await(counterRef.set(mapOf("balance" to 200L)), 10, TimeUnit.SECONDS)
                    txn.update(counterRef, "balance", current + 10L)
                    current + 10L
                },
                10,
                TimeUnit.SECONDS
            )
            fail("Expected FAILED_PRECONDITION from live host after exhausting setMaxAttempts(1)")
        } catch (err: ExecutionException) {
            val cause = err.cause as? FirebaseFirestoreException
                ?: fail("Expected FirebaseFirestoreException cause, got: ${err.cause}")
            assertEquals(FirebaseFirestoreException.Code.FAILED_PRECONDITION, cause.code)
        }
        assertEquals(1, exhaustedAttempts.get())
        assertEquals(200L, Tasks.await(counterRef.get(), 10, TimeUnit.SECONDS).getLong("balance"))
    }

    @Test
    @DisplayName("proves terminate unsubscribes active snapshot flows, rejects post-terminate calls, and allows getInstance restart (#11)")
    fun `proves terminate unsubscribes active snapshot flows, rejects post-terminate calls, and allows getInstance restart`() {
        val docRef = firestore.document("users/$uid")
        Tasks.await(docRef.set(mapOf("phase" to "initial")), 10, TimeUnit.SECONDS)

        val initialSeen = CountDownLatch(1)
        val flowCompleted = CountDownLatch(1)
        val listenerErrors = CopyOnWriteArrayList<FirebaseFirestoreException>()
        val scope = CoroutineScope(Dispatchers.IO)

        val listenerReg = docRef.addSnapshotListener { _, err ->
            if (err != null) {
                listenerErrors.add(err)
            }
        }
        scope.launch {
            docRef.snapshots().collect { snap ->
                if (snap.exists()) {
                    initialSeen.countDown()
                }
            }
            flowCompleted.countDown()
        }

        try {
            assertTrue(initialSeen.await(10, TimeUnit.SECONDS))

            Tasks.await(firestore.terminate(), 10, TimeUnit.SECONDS)
            // Idempotent second call
            Tasks.await(firestore.terminate(), 10, TimeUnit.SECONDS)
            assertTrue(firestore.isTerminated)
            assertTrue(flowCompleted.await(10, TimeUnit.SECONDS))
            assertTrue(listenerErrors.isEmpty())

            assertThrows(IllegalStateException::class.java) { firestore.document("users/$uid") }
            assertThrows(IllegalStateException::class.java) { docRef.get() }
            assertThrows(IllegalStateException::class.java) { docRef.set(mapOf("phase" to "after-terminate")) }
            assertThrows(IllegalStateException::class.java) { firestore.runTransaction { "nope" } }

            // Shared FirebaseApp bridge remains alive; getInstance returns a fresh operational client
            val client = requireNotNull(bridgeClient)
            val restarted = FirebaseFirestore.getInstance(app, client)
            assertNotSame(firestore, restarted)
            assertFalse(restarted.isTerminated)

            val restartedDoc = restarted.document("users/$uid")
            Tasks.await(restartedDoc.update("phase", "restarted"), 10, TimeUnit.SECONDS)
            val snap = Tasks.await(restartedDoc.get(), 10, TimeUnit.SECONDS)
            assertEquals("restarted", snap.getString("phase"))
        } finally {
            listenerReg.remove()
            scope.cancel()
        }
    }

    @Test
    @DisplayName("proves CollectionReference.document auto-IDs and CollectionReference.add POJO, validation, and rules errors (#37, #38)")
    fun `proves CollectionReference document auto-IDs and CollectionReference add POJO, validation, and rules errors`() {
        val itemsCol = firestore.collection("users/$uid/items")
        val autoOne = itemsCol.document()
        val autoTwo = itemsCol.document()
        assertEquals(20, autoOne.id.length)
        assertEquals(20, autoTwo.id.length)
        assertTrue(autoOne.id.all { it.isLetterOrDigit() })
        assertFalse(autoOne.id == autoTwo.id)

        val namedDoc = itemsCol.document("desk-lamp")
        assertEquals("users/$uid/items/desk-lamp", namedDoc.path)
        assertThrows(IllegalArgumentException::class.java) { itemsCol.document("") }
        assertThrows(IllegalArgumentException::class.java) { itemsCol.document("nested/even") }

        val addedPojoRef = Tasks.await(
            itemsCol.add(CatalogItem(id = "ignored-on-write", title = "Keyboard", quantity = 3L)),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(20, addedPojoRef.id.length)
        val addedSnap = Tasks.await(addedPojoRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(addedSnap.exists())
        assertNull(addedSnap.getData()?.get("id"))
        val decoded = addedSnap.toObject(CatalogItem::class.java)
        assertNotNull(decoded)
        assertEquals(addedPojoRef.id, decoded?.id)
        assertEquals("Keyboard", decoded?.title)
        assertEquals(3L, decoded?.quantity)
        assertNotNull(decoded?.createdAt)

        assertThrows(IllegalArgumentException::class.java) {
            itemsCol.add(mapOf("bad" to FieldValue.delete()))
        }

        // Security Rules denial on CollectionReference.add must reject the Task with PERMISSION_DENIED
        val forbiddenCol = firestore.collection("users/another-owner/items")
        assertPermissionDenied {
            Tasks.await(forbiddenCol.add(mapOf("title" to "Intrusion")), 10, TimeUnit.SECONDS)
        }
    }

    @Test
    @DisplayName("proves all FieldValue sentinels and rich data codecs including nested collections on live host (#54-#63)")
    fun `proves all FieldValue sentinels and rich data codecs including nested collections on live host`() {
        val docRef = firestore.document("users/$uid/items/codec-showcase")
        val targetDocRef = firestore.document("users/$uid/items/referenced-target")
        Tasks.await(targetDocRef.set(mapOf("label" to "Target Ready")), 10, TimeUnit.SECONDS)

        val preEpochTs = Timestamp(-1L, 500_000_000)
        val modernDate = Date(1_715_000_123_000L)
        val southPoleWest = GeoPoint(-90.0, -180.0)
        val northPoleEast = GeoPoint(90.0, 180.0)
        val emptyBlob = Blob.fromBytes(byteArrayOf())
        val binaryBlob = Blob.fromBytes(
            byteArrayOf(0x00, 0x01, 0x7F, 0x80.toByte(), 0xF8.toByte(), 0xFC.toByte(), 0xFF.toByte())
        )

        assertThrows(IllegalArgumentException::class.java) {
            docRef.set(mapOf("arr" to listOf(FieldValue.serverTimestamp())))
        }
        assertThrows(IllegalArgumentException::class.java) {
            docRef.set(mapOf("gone" to FieldValue.delete()))
        }

        Tasks.await(
            docRef.set(
                mapOf(
                    "committedAt" to FieldValue.serverTimestamp(),
                    "intCount" to 10L,
                    "floatScore" to 1.25,
                    "tags" to listOf("initial", "dup"),
                    "obsolete" to "remove-me",
                    "preEpoch" to preEpochTs,
                    "fromDate" to modernDate,
                    "origin" to southPoleWest,
                    "emptyBytes" to emptyBlob,
                    "binaryBytes" to binaryBlob,
                    "refField" to targetDocRef,
                    "deep" to mapOf(
                        "nestedTs" to FieldValue.serverTimestamp(),
                        "nestedDrop" to "temporary",
                        "nestedRefs" to listOf(targetDocRef),
                        "nestedPoints" to listOf(southPoleWest, northPoleEast),
                        "specialNumbers" to mapOf(
                            "nanVal" to Double.NaN,
                            "posInf" to Double.POSITIVE_INFINITY,
                            "negInf" to Double.NEGATIVE_INFINITY,
                            "negZero" to -0.0
                        ),
                        "matrix" to listOf(
                            mapOf("flag" to true, "nothing" to null, "blob" to binaryBlob)
                        )
                    )
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        // Update with serverTimestamp, delete, Long & Double increment, arrayUnion, arrayRemove
        Tasks.await(
            docRef.update(
                mapOf(
                    "updatedAt" to FieldValue.serverTimestamp(),
                    "intCount" to FieldValue.increment(7L),
                    "floatScore" to FieldValue.increment(2.5),
                    "freshCounter" to FieldValue.increment(4L),
                    "tags" to FieldValue.arrayUnion("dup", "added"),
                    "obsolete" to FieldValue.delete(),
                    "deep.nestedDrop" to FieldValue.delete()
                )
            ),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            docRef.update("tags", FieldValue.arrayRemove("initial", "absent")),
            10,
            TimeUnit.SECONDS
        )
        // SetOptions.merge() with FieldValue.delete() also removes field cleanly
        Tasks.await(
            docRef.set(mapOf("fromDate" to FieldValue.delete()), SetOptions.merge()),
            10,
            TimeUnit.SECONDS
        )

        val snap = Tasks.await(docRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(snap.exists())
        assertTrue(snap.get("committedAt") is Timestamp)
        assertTrue(snap.get("updatedAt") is Timestamp)
        assertEquals(17L, snap.getLong("intCount"))
        assertEquals(3.75, snap.getDouble("floatScore") ?: 0.0, 1e-9)
        assertEquals(4L, snap.getLong("freshCounter"))
        assertEquals(listOf("dup", "added"), snap.get("tags"))
        assertNull(snap.get("obsolete"))
        assertNull(snap.get("fromDate"))
        assertEquals(preEpochTs, snap.getTimestamp("preEpoch"))
        assertEquals(southPoleWest, snap.getGeoPoint("origin"))
        assertArrayEquals(byteArrayOf(), (snap.get("emptyBytes") as Blob).toBytes())
        assertArrayEquals(binaryBlob.toBytes(), (snap.get("binaryBytes") as Blob).toBytes())

        val revivedRef = snap.get("refField") as DocumentReference
        assertEquals(targetDocRef.path, revivedRef.path)
        assertSame(firestore, revivedRef.firestore)
        val followedSnap = Tasks.await(revivedRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("Target Ready", followedSnap.getString("label"))

        @Suppress("UNCHECKED_CAST")
        val deep = snap.get("deep") as Map<String, Any?>
        assertTrue(deep["nestedTs"] is Timestamp)
        assertFalse(deep.containsKey("nestedDrop"))
        val nestedRefs = deep["nestedRefs"] as List<*>
        assertEquals(targetDocRef.path, (nestedRefs[0] as DocumentReference).path)
        assertEquals(listOf(southPoleWest, northPoleEast), deep["nestedPoints"])

        @Suppress("UNCHECKED_CAST")
        val specialNumbers = deep["specialNumbers"] as Map<String, Any?>
        assertTrue((specialNumbers["nanVal"] as Double).isNaN())
        assertEquals(Double.POSITIVE_INFINITY, specialNumbers["posInf"])
        assertEquals(Double.NEGATIVE_INFINITY, specialNumbers["negInf"])
        assertEquals(
            java.lang.Double.doubleToRawLongBits(-0.0),
            java.lang.Double.doubleToRawLongBits(specialNumbers["negZero"] as Double)
        )

        @Suppress("UNCHECKED_CAST")
        val matrixRow = (deep["matrix"] as List<*>)[0] as Map<String, Any?>
        assertEquals(true, matrixRow["flag"])
        assertNull(matrixRow["nothing"])
        assertArrayEquals(binaryBlob.toBytes(), (matrixRow["blob"] as Blob).toBytes())
    }

    @Test
    @DisplayName("proves Android 35.2.0 FirebaseFirestoreSettings defaults, LocalCacheSettings, and Kotlin DSL properties (#3)")
    fun `proves Android 35 2 0 FirebaseFirestoreSettings defaults LocalCacheSettings and Kotlin DSL properties`() {
        val defaultBuilt = FirebaseFirestoreSettings.Builder().build()
        assertEquals("firestore.googleapis.com", defaultBuilt.host)
        assertTrue(defaultBuilt.isSslEnabled)
        assertTrue(defaultBuilt.isPersistenceEnabled)

        val persistentBuilt = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(
                com.google.firebase.firestore.PersistentCacheSettings.newBuilder()
                    .setSizeBytes(20L * 1024L * 1024L)
                    .build()
            )
            .build()
        assertEquals("firestore.googleapis.com", persistentBuilt.host)
        assertTrue(persistentBuilt.isSslEnabled)
        assertTrue(persistentBuilt.cacheSettings is com.google.firebase.firestore.PersistentCacheSettings)
        assertEquals(20L * 1024L * 1024L, persistentBuilt.cacheSizeBytes)

        val dslClient = PyricBridgeClient(url = liveBridgeUrl)
        try {
            val dslApp = FirebaseApp.initializeApp(
                "dsl-settings-fs-app-${System.nanoTime()}",
                FirebaseOptions.Builder()
                    .setProjectId(projectId)
                    .setApiKey("dsl-api-key")
                    .setApplicationId("1:424242424242:android:dsl")
                    .build()
            )
            val dslFs = FirebaseFirestore.getInstance(dslApp, dslClient)
            dslFs.firestoreSettings = firestoreSettings {
                host = "127.0.0.1:8085"
                isSslEnabled = false
                setLocalCacheSettings(com.google.firebase.firestore.memoryCacheSettings {})
            }
            assertEquals("127.0.0.1:8085", dslFs.firestoreSettings.host)
            assertFalse(dslFs.firestoreSettings.isSslEnabled)
            assertFalse(dslFs.firestoreSettings.isPersistenceEnabled)
            assertTrue(dslFs.firestoreSettings.cacheSettings is com.google.firebase.firestore.MemoryCacheSettings)
        } finally {
            runBlocking { dslClient.disconnect() }
        }
    }

    private fun assertPermissionDenied(block: () -> Unit) {
        try {
            block()
            fail("Expected FirebaseFirestoreException(PERMISSION_DENIED)")
        } catch (err: ExecutionException) {
            val cause = err.cause as? FirebaseFirestoreException
                ?: fail("Expected FirebaseFirestoreException cause, got: ${err.cause}")
            assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, cause.code)
        }
    }

    companion object {
        private const val DEFAULT_PROJECT_ID = "demo-kotlin-live"
        private const val USER_PASSWORD = "live-firestore-password-123"
    }
}
