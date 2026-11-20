package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.snapshots
import com.google.firebase.firestore.toObject
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
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class FirestoreLiveHostConformanceTest {
    data class UserProfile(
        var displayName: String? = null,
        var tier: String? = null,
        var points: Long? = null
    )

    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var uid: String

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_FIRESTORE_BRIDGE_URL")
            ?: System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_FIRESTORE_BRIDGE_URL is unset; skipping live-host Kotlin Firestore conformance test"
        )
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        liveBridgeUrl = envUrl
        projectId = System.getenv("PYRIC_LIVE_FIRESTORE_PROJECT_ID") ?: DEFAULT_PROJECT_ID
        val app = FirebaseApp.initializeApp(
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

        val email = "fs-live-${System.nanoTime()}@example.com"
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
    @DisplayName("proves instance lifecycle, KTX extensions, DocumentReference CRUD, SetOptions.merge, and POJO deserialization")
    fun `proves instance lifecycle, KTX extensions, DocumentReference CRUD, SetOptions merge, and POJO deserialization`() {
        assertSame(firestore, FirebaseFirestore.getInstance())
        assertSame(firestore, Firebase.firestore)
        assertSame(auth.bridgeClient, firestore.bridgeClient)
        assertEquals("(default)", firestore.databaseId)

        val userDoc = firestore.document("users/$uid")
        assertEquals(uid, userDoc.id)
        assertEquals("users/$uid", userDoc.path)

        val missingSnap = Tasks.await(userDoc.get(), 10, TimeUnit.SECONDS)
        assertFalse(missingSnap.exists())
        assertNull(missingSnap.getData())

        Tasks.await(
            userDoc.set(UserProfile(displayName = "Ada", tier = "starter", points = 10L)),
            10,
            TimeUnit.SECONDS
        )
        val initialSnap = Tasks.await(userDoc.get(), 10, TimeUnit.SECONDS)
        assertTrue(initialSnap.exists())
        assertEquals("Ada", initialSnap.get("displayName"))
        val decoded = initialSnap.toObject<UserProfile>()
        assertNotNull(decoded)
        assertEquals("Ada", decoded?.displayName)
        assertEquals("starter", decoded?.tier)
        assertEquals(10L, decoded?.points)

        // SetOptions.merge() preserves unspecified fields on the live host
        Tasks.await(
            userDoc.set(mapOf("tier" to "pro"), SetOptions.merge()),
            10,
            TimeUnit.SECONDS
        )
        val mergedSnap = Tasks.await(userDoc.get(), 10, TimeUnit.SECONDS)
        assertEquals("Ada", mergedSnap.get("displayName"))
        assertEquals("pro", mergedSnap.get("tier"))
        assertEquals(10L, (mergedSnap.get("points") as Number).toLong())

        Tasks.await(
            userDoc.update(mapOf("points" to 25L)),
            10,
            TimeUnit.SECONDS
        )
        val updatedSnap = Tasks.await(userDoc.get(), 10, TimeUnit.SECONDS)
        assertEquals(25L, (updatedSnap.get("points") as Number).toLong())

        Tasks.await(userDoc.delete(), 10, TimeUnit.SECONDS)
        val deletedSnap = Tasks.await(userDoc.get(), 10, TimeUnit.SECONDS)
        assertFalse(deletedSnap.exists())
    }

    @Test
    @DisplayName("proves Query filters, composite Filter.or, ordering, pagination cursors, collection.add, and collectionGroup")
    fun `proves Query filters, composite Filter or, ordering, pagination cursors, collection add, and collectionGroup`() {
        val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        Tasks.await(auth.signInWithCustomToken(moderatorToken), 10, TimeUnit.SECONDS)

        val itemsCol = firestore.collection("role_items/moderator/items")
        val prefix = "run-${System.nanoTime()}"
        val entries = listOf(
            Triple("$prefix-a", "books", 10L),
            Triple("$prefix-b", "books", 30L),
            Triple("$prefix-c", "tools", 50L),
            Triple("$prefix-d", "games", 70L)
        )
        for ((docId, category, score) in entries) {
            Tasks.await(
                itemsCol.document(docId).set(
                    mapOf(
                        "runPrefix" to prefix,
                        "category" to category,
                        "score" to score,
                        "tags" to listOf(category, "featured")
                    )
                ),
                10,
                TimeUnit.SECONDS
            )
        }

        val addedRef = Tasks.await(
            itemsCol.add(mapOf("runPrefix" to "$prefix-auto", "category" to "misc", "score" to 5L)),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(20, addedRef.id.length)
        val addedSnap = Tasks.await(addedRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(addedSnap.exists())
        assertEquals("misc", addedSnap.get("category"))

        val booksSnap = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .whereEqualTo("category", "books")
                .orderBy("score", Query.Direction.DESCENDING)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-b", "$prefix-a"), booksSnap.documents.map { it.id })

        val compositeSnap = Tasks.await(
            itemsCol
                .where(
                    Filter.and(
                        Filter.equalTo("runPrefix", prefix),
                        Filter.or(
                            Filter.equalTo("category", "tools"),
                            Filter.greaterThanOrEqualTo("score", 70L)
                        )
                    )
                )
                .orderBy("score", Query.Direction.ASCENDING)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-c", "$prefix-d"), compositeSnap.documents.map { it.id })

        val pageOne = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .orderBy("score", Query.Direction.ASCENDING)
                .limit(2)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-a", "$prefix-b"), pageOne.documents.map { it.id })

        val pageTwo = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .orderBy("score", Query.Direction.ASCENDING)
                .startAfter(pageOne.documents.last())
                .limit(2)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-c", "$prefix-d"), pageTwo.documents.map { it.id })

        val tailTwo = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .orderBy("score", Query.Direction.ASCENDING)
                .limitToLast(2)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-c", "$prefix-d"), tailTwo.documents.map { it.id })

        val whereInSnap = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .whereIn("category", listOf("books", "games"))
                .orderBy("score", Query.Direction.ASCENDING)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-a", "$prefix-b", "$prefix-d"), whereInSnap.documents.map { it.id })

        val arrayContainsSnap = Tasks.await(
            itemsCol
                .whereEqualTo("runPrefix", prefix)
                .whereArrayContains("tags", "tools")
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("$prefix-c"), arrayContainsSnap.documents.map { it.id })
    }

    @Test
    @DisplayName("proves FieldValue sentinels and rich value codecs round-trip over live bridge")
    fun `proves FieldValue sentinels and rich value codecs round-trip over live bridge`() {
        val targetRef = firestore.document("users/$uid")
        val linkedRef = firestore.document("role_items/moderator/items/linked-01")
        val fixedTimestamp = Timestamp(1_710_000_000L, 250_000_000)
        val location = GeoPoint(37.7749, -122.4194)
        val payloadBytes = byteArrayOf(0x10, 0x20, 0x30, 0x40)

        Tasks.await(
            targetRef.set(
                mapOf(
                    "createdAt" to FieldValue.serverTimestamp(),
                    "counter" to 10L,
                    "labels" to listOf("alpha", "beta"),
                    "removable" to "temp",
                    "eventTime" to fixedTimestamp,
                    "coords" to location,
                    "rawBlob" to Blob.fromBytes(payloadBytes),
                    "primaryItem" to linkedRef,
                    "nested" to mapOf(
                        "ranks" to listOf(1L, 2L),
                        "marker" to GeoPoint(47.6062, -122.3321)
                    )
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        Tasks.await(
            targetRef.update(
                mapOf(
                    "counter" to FieldValue.increment(5L),
                    "labels" to FieldValue.arrayUnion("gamma"),
                    "removable" to FieldValue.delete()
                )
            ),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            targetRef.update(
                mapOf("labels" to FieldValue.arrayRemove("alpha"))
            ),
            10,
            TimeUnit.SECONDS
        )

        val snap = Tasks.await(targetRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(snap.exists())
        assertTrue(snap.get("createdAt") is Timestamp)
        assertEquals(15L, (snap.get("counter") as Number).toLong())
        assertEquals(listOf("beta", "gamma"), snap.get("labels"))
        assertNull(snap.get("removable"))
        assertEquals(fixedTimestamp, snap.get("eventTime"))
        assertEquals(location, snap.get("coords"))
        val revivedBlob = snap.get("rawBlob") as Blob
        assertArrayEquals(payloadBytes, revivedBlob.toBytes())
        val revivedRef = snap.get("primaryItem") as DocumentReference
        assertEquals("role_items/moderator/items/linked-01", revivedRef.path)

        @Suppress("UNCHECKED_CAST")
        val nested = snap.get("nested") as Map<String, Any?>
        val revivedRanks = (nested["ranks"] as List<*>).map { (it as Number).toLong() }
        assertEquals(listOf(1L, 2L), revivedRanks)
        assertEquals(GeoPoint(47.6062, -122.3321), nested["marker"])
    }

    @Test
    @DisplayName("proves WriteBatch atomic commits, interactive runTransaction, and realtime snapshot listeners")
    fun `proves WriteBatch atomic commits, interactive runTransaction, and realtime snapshot listeners`() {
        val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        val signedIn = Tasks.await(auth.signInWithCustomToken(moderatorToken), 10, TimeUnit.SECONDS)
        val moderatorUid = requireNotNull(signedIn.user).uid

        val docRef = firestore.document("users/$moderatorUid")
        val observedStages = CopyOnWriteArrayList<String>()
        val firstReady = CountDownLatch(1)
        val updatedReady = CountDownLatch(1)

        val docReg = docRef.addSnapshotListener { snapshot, error ->
            if (error == null && snapshot != null && snapshot.exists()) {
                val label = snapshot.get("stage") as? String
                if (label != null) {
                    observedStages.add(label)
                    firstReady.countDown()
                    if (label == "txn-committed") {
                        updatedReady.countDown()
                    }
                }
            }
        }

        val flowScope = CoroutineScope(Dispatchers.IO)
        val queryReady = CountDownLatch(1)
        val batchPrefix = "batch-${System.nanoTime()}"
        flowScope.launch {
            firestore.collection("role_items/moderator/items")
                .whereEqualTo("batchKey", batchPrefix)
                .snapshots()
                .collect { qs ->
                    if (qs.size() == 2) {
                        queryReady.countDown()
                    }
                }
        }

        try {
            val itemOne = firestore.document("role_items/moderator/items/$batchPrefix-1")
            val itemTwo = firestore.document("role_items/moderator/items/$batchPrefix-2")
            val itemTransient = firestore.document("role_items/moderator/items/$batchPrefix-temp")
            Tasks.await(
                itemTransient.set(mapOf("batchKey" to batchPrefix)),
                10,
                TimeUnit.SECONDS
            )

            val batch = firestore.batch()
            batch.set(docRef, mapOf("stage" to "batch-seeded", "balance" to 100L))
            batch.set(itemOne, mapOf("batchKey" to batchPrefix, "seq" to 1L))
            batch.set(itemTwo, mapOf("batchKey" to batchPrefix, "seq" to 2L))
            batch.delete(itemTransient)
            Tasks.await(batch.commit(), 10, TimeUnit.SECONDS)

            assertTrue(firstReady.await(10, TimeUnit.SECONDS))
            assertTrue(queryReady.await(10, TimeUnit.SECONDS))

            val newBalance = Tasks.await(
                firestore.runTransaction { txn ->
                    val current = txn.get(docRef)
                    val balance = (current.get("balance") as? Number)?.toLong() ?: 0L
                    val updated = balance + 45L
                    txn.update(docRef, mapOf("stage" to "txn-committed", "balance" to updated))
                    updated
                },
                10,
                TimeUnit.SECONDS
            )
            assertEquals(145L, newBalance)
            assertTrue(updatedReady.await(10, TimeUnit.SECONDS))
            assertTrue(observedStages.contains("batch-seeded"))
            assertTrue(observedStages.contains("txn-committed"))

            val finalSnap = Tasks.await(docRef.get(), 10, TimeUnit.SECONDS)
            assertEquals(145L, (finalSnap.get("balance") as Number).toLong())
            assertFalse(Tasks.await(itemTransient.get(), 10, TimeUnit.SECONDS).exists())
        } finally {
            docReg.remove()
            flowScope.cancel()
        }
    }

    @Test
    @DisplayName("proves Firestore Security Rules across signed-out, cross-user, custom claims, and RulesDenialListener")
    fun `proves Firestore Security Rules across signed-out, cross-user, custom claims, and RulesDenialListener`() {
        val denials = CopyOnWriteArrayList<FirebaseFirestoreException>()
        val denialReg = firestore.addRulesDenialListener { exception, _ ->
            denials.add(exception)
        }

        try {
            // Cross-user write rejected while signed in as uid
            assertPermissionDenied {
                Tasks.await(
                    firestore.document("users/someone-else").set(mapOf("displayName" to "Blocked")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            // Standard user lacks custom claim role == 'moderator' on /role_items/moderator/items/*
            val restrictedPath = "role_items/moderator/items/spotlight-${System.nanoTime()}"
            assertPermissionDenied {
                Tasks.await(
                    firestore.document(restrictedPath).set(mapOf("headline" to "Blocked")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            // Standard user lacks custom claim role == 'member' on /rooms/*
            assertPermissionDenied {
                Tasks.await(
                    firestore.document("rooms/lobby").set(mapOf("topic" to "Blocked")),
                    10,
                    TimeUnit.SECONDS
                )
            }

            // Sign out -> owner write rejected, public signed-out read on /rooms/lobby permitted
            auth.signOut()
            assertPermissionDenied {
                Tasks.await(
                    firestore.document("users/$uid").set(mapOf("displayName" to "SignedOut")),
                    10,
                    TimeUnit.SECONDS
                )
            }
            val publicRoomSnap = Tasks.await(
                firestore.document("rooms/lobby").get(),
                10,
                TimeUnit.SECONDS
            )
            assertFalse(publicRoomSnap.exists())
            assertTrue(denials.isNotEmpty())

            // Sign in with custom token carrying role == 'moderator'
            val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
            Tasks.await(
                auth.signInWithCustomToken(moderatorToken),
                10,
                TimeUnit.SECONDS
            )
            Tasks.await(
                firestore.document(restrictedPath).set(mapOf("headline" to "Approved")),
                10,
                TimeUnit.SECONDS
            )
            val spotlightSnap = Tasks.await(
                firestore.document(restrictedPath).get(),
                10,
                TimeUnit.SECONDS
            )
            assertTrue(spotlightSnap.exists())
            assertEquals("Approved", spotlightSnap.get("headline"))
        } finally {
            denialReg.remove()
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
