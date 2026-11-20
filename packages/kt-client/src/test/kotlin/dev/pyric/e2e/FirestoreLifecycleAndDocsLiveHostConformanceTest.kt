package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.ServerTimestamp
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.SnapshotMetadata
import com.google.firebase.firestore.Source
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class FirestoreLifecycleAndDocsLiveHostConformanceTest {
    data class ProfileNote(
        @DocumentId
        var docId: String? = null,
        var headline: String? = null,
        var priority: Long? = null,
        @ServerTimestamp
        var updatedAt: Timestamp? = null
    )

    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var uid: String
    private lateinit var userEmail: String

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_FIRESTORE_BRIDGE_URL")
            ?: System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_FIRESTORE_BRIDGE_URL is unset; skipping live-host Kotlin Firestore lifecycle/docs test"
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

        val email = "fs-docs-${System.nanoTime()}@example.com"
        userEmail = email
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
    @DisplayName("proves clearPersistence precondition checks and persisted cache wipe after terminate (#9)")
    fun `proves clearPersistence precondition checks and persisted cache wipe after terminate`() {
        val secondaryClient = PyricBridgeClient(url = liveBridgeUrl)
        try {
            val secondaryApp = FirebaseApp.initializeApp(
                "unstarted-persistence-app",
                FirebaseOptions.Builder()
                    .setProjectId(projectId)
                    .setApiKey("secondary-key")
                    .setApplicationId("1:424242424242:android:unstarted")
                    .build()
            )
            val unstartedFs = FirebaseFirestore.getInstance(secondaryApp, secondaryClient)
            // Unstarted client clears persistence cleanly
            Tasks.await(unstartedFs.clearPersistence(), 10, TimeUnit.SECONDS)
        } finally {
            runBlocking { secondaryClient.disconnect() }
        }

        val docRef = firestore.document("users/$uid/items/persisted-entry")
        Tasks.await(docRef.set(mapOf("label" to "Cached Across Restart")), 10, TimeUnit.SECONDS)
        val cachedBeforeTerminate = Tasks.await(docRef.get(Source.CACHE), 10, TimeUnit.SECONDS)
        assertTrue(cachedBeforeTerminate.exists())
        assertTrue(cachedBeforeTerminate.metadata.isFromCache)
        assertEquals("Cached Across Restart", cachedBeforeTerminate.getString("label"))

        // Running client rejects clearPersistence with FAILED_PRECONDITION
        assertFirestoreCode(FirebaseFirestoreException.Code.FAILED_PRECONDITION) {
            Tasks.await(firestore.clearPersistence(), 10, TimeUnit.SECONDS)
        }

        val client = requireNotNull(bridgeClient)
        Tasks.await(firestore.terminate(), 10, TimeUnit.SECONDS)

        // Without clearPersistence, a restarted instance still reads persisted cache
        val restartedKeepCache = FirebaseFirestore.getInstance(app, client)
        assertNotSame(firestore, restartedKeepCache)
        val survivedSnap = Tasks.await(
            restartedKeepCache.document("users/$uid/items/persisted-entry").get(Source.CACHE), 10, TimeUnit.SECONDS
        )
        assertTrue(survivedSnap.exists() && survivedSnap.metadata.isFromCache)
        assertEquals("Cached Across Restart", survivedSnap.getString("label"))

        // Running client rejects clearPersistence with FAILED_PRECONDITION
        assertFirestoreCode(FirebaseFirestoreException.Code.FAILED_PRECONDITION) {
            Tasks.await(restartedKeepCache.clearPersistence(), 10, TimeUnit.SECONDS)
        }

        // Terminate then clearPersistence wipes persisted cache for subsequent instances
        Tasks.await(restartedKeepCache.terminate(), 10, TimeUnit.SECONDS)
        Tasks.await(restartedKeepCache.clearPersistence(), 10, TimeUnit.SECONDS)

        val restartedFresh = FirebaseFirestore.getInstance(app, client)
        firestore = restartedFresh
        assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
            Tasks.await(restartedFresh.document("users/$uid/items/persisted-entry").get(Source.CACHE), 10, TimeUnit.SECONDS)
        }
        val serverSnap = Tasks.await(
            restartedFresh.document("users/$uid/items/persisted-entry").get(Source.SERVER), 10, TimeUnit.SECONDS
        )
        assertTrue(serverSnap.exists())
        assertFalse(serverSnap.metadata.isFromCache)
        assertEquals("Cached Across Restart", serverSnap.getString("label"))
    }

    @Test
    @DisplayName("proves disableNetwork, enableNetwork, offline mutation staging, and waitForPendingWrites (#10, #12)")
    fun `proves disableNetwork, enableNetwork, offline mutation staging, and waitForPendingWrites`() {
        // Idle barrier resolves immediately
        Tasks.await(firestore.waitForPendingWrites(), 10, TimeUnit.SECONDS)

        val queueDoc = firestore.document("users/$uid/items/offline-fifo")
        val ephemeralDoc = firestore.document("users/$uid/items/offline-ephemeral")
        Tasks.await(queueDoc.set(mapOf("seq" to 0L, "keep" to "seed")), 10, TimeUnit.SECONDS)

        Tasks.await(firestore.disableNetwork(), 10, TimeUnit.SECONDS)

        // Shared FirebaseApp bridge remains connected for FirebaseAuth while Firestore is offline
        val reauthed = Tasks.await(
            auth.signInWithEmailAndPassword(userEmail, USER_PASSWORD),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(uid, reauthed.user?.uid)

        val w1 = queueDoc.set(mapOf("seq" to 1L, "keep" to "overwritten", "tags" to listOf("s1")))
        val w2 = queueDoc.set(mapOf("seq" to 2L, "mergedFlag" to true), SetOptions.merge())
        val w3 = queueDoc.update(
            mapOf(
                "seq" to FieldValue.increment(3L),
                "tags" to FieldValue.arrayUnion("s2", "s3")
            )
        )
        val w4 = ephemeralDoc.set(mapOf("temp" to true))
        val w5 = ephemeralDoc.delete()

        assertFalse(w1.isComplete)
        assertFalse(w2.isComplete)
        assertFalse(w3.isComplete)
        assertFalse(w4.isComplete)
        assertFalse(w5.isComplete)

        val pendingBarrier = firestore.waitForPendingWrites()
        assertFalse(pendingBarrier.isComplete)

        // Local cache and offline DEFAULT reads immediately project staged FIFO mutations
        for (source in listOf(Source.CACHE, Source.DEFAULT)) {
            val stagedSnap = Tasks.await(queueDoc.get(source), 10, TimeUnit.SECONDS)
            assertTrue(stagedSnap.exists())
            assertTrue(stagedSnap.metadata.isFromCache)
            assertTrue(stagedSnap.metadata.hasPendingWrites)
            assertEquals(5L, stagedSnap.getLong("seq"))
            assertEquals("overwritten", stagedSnap.getString("keep"))
            assertEquals(true, stagedSnap.getBoolean("mergedFlag"))
            assertEquals(listOf("s1", "s2", "s3"), stagedSnap.get("tags"))
        }

        val deletedLocal = Tasks.await(ephemeralDoc.get(Source.CACHE), 10, TimeUnit.SECONDS)
        assertFalse(deletedLocal.exists())
        assertTrue(deletedLocal.metadata.isFromCache)
        assertTrue(deletedLocal.metadata.hasPendingWrites)

        // Re-enabling network flushes queued writes in FIFO order and resolves barrier + write Tasks
        Tasks.await(firestore.enableNetwork(), 10, TimeUnit.SECONDS)
        Tasks.await(pendingBarrier, 10, TimeUnit.SECONDS)
        for (writeTask in listOf(w1, w2, w3, w4, w5)) {
            Tasks.await(writeTask, 10, TimeUnit.SECONDS)
        }

        val committedSnap = Tasks.await(queueDoc.get(Source.SERVER), 10, TimeUnit.SECONDS)
        assertTrue(committedSnap.exists())
        assertFalse(committedSnap.metadata.isFromCache)
        assertFalse(committedSnap.metadata.hasPendingWrites)
        assertEquals(5L, committedSnap.getLong("seq"))
        assertEquals("overwritten", committedSnap.getString("keep"))
        assertEquals(true, committedSnap.getBoolean("mergedFlag"))
        assertEquals(listOf("s1", "s2", "s3"), committedSnap.get("tags"))

        val committedEphemeral = Tasks.await(ephemeralDoc.get(Source.SERVER), 10, TimeUnit.SECONDS)
        assertFalse(committedEphemeral.exists())

        // Failed offline update rejects its own Task with NOT_FOUND on reconnect while resolving waitForPendingWrites
        Tasks.await(firestore.disableNetwork(), 10, TimeUnit.SECONDS)
        val missingUpdate = firestore.document("users/$uid/items/offline-missing-target").update("v", 1L)
        val failBarrier = firestore.waitForPendingWrites()
        assertFalse(missingUpdate.isComplete)
        assertFalse(failBarrier.isComplete)

        Tasks.await(firestore.enableNetwork(), 10, TimeUnit.SECONDS)
        Tasks.await(failBarrier, 10, TimeUnit.SECONDS)
        assertFirestoreCode(FirebaseFirestoreException.Code.NOT_FOUND) {
            Tasks.await(missingUpdate, 10, TimeUnit.SECONDS)
        }
    }

    @Test
    @DisplayName("proves addSnapshotsInSyncListener initial, reconnect, Executor, and removal behavior (#13)")
    fun `proves addSnapshotsInSyncListener initial, reconnect, Executor, and removal behavior`() {
        val docRef = firestore.document("users/$uid/items/sync-probe")
        Tasks.await(docRef.set(mapOf("version" to 1L)), 10, TimeUnit.SECONDS)

        val firstSyncLatch = CountDownLatch(1)
        val defaultCalls = AtomicInteger(0)
        val defaultReg = firestore.addSnapshotsInSyncListener {
            defaultCalls.incrementAndGet()
            firstSyncLatch.countDown()
        }

        val executorCalls = AtomicInteger(0)
        val customExecutorLatch = CountDownLatch(1)
        val directExecutor = Executor { runnable ->
            executorCalls.incrementAndGet()
            runnable.run()
        }
        val executorReg = firestore.addSnapshotsInSyncListener(directExecutor) {
            customExecutorLatch.countDown()
        }

        var docListenerReg: com.google.firebase.firestore.ListenerRegistration? = null
        try {
            assertTrue(firstSyncLatch.await(10, TimeUnit.SECONDS))
            assertTrue(customExecutorLatch.await(10, TimeUnit.SECONDS))
            assertTrue(executorCalls.get() >= 1)

            // Unregister default listener and verify its count stays frozen across future syncs
            defaultReg.remove()
            val frozenDefaultCount = defaultCalls.get()

            val serverSyncedLatch = CountDownLatch(1)
            val postReconnectSyncLatch = CountDownLatch(1)
            var observePostReconnect = false
            val secondSyncReg = firestore.addSnapshotsInSyncListener {
                if (observePostReconnect) {
                    postReconnectSyncLatch.countDown()
                }
            }

            try {
                docListenerReg = docRef.addSnapshotListener(MetadataChanges.INCLUDE) { snap, err ->
                    if (err == null && snap != null && !snap.metadata.isFromCache && !snap.metadata.hasPendingWrites) {
                        serverSyncedLatch.countDown()
                    }
                }
                assertTrue(serverSyncedLatch.await(10, TimeUnit.SECONDS))

                Tasks.await(firestore.disableNetwork(), 10, TimeUnit.SECONDS)
                val stagedTask = docRef.update("version", 2L)
                observePostReconnect = true
                Tasks.await(firestore.enableNetwork(), 10, TimeUnit.SECONDS)
                Tasks.await(stagedTask, 10, TimeUnit.SECONDS)

                assertTrue(postReconnectSyncLatch.await(10, TimeUnit.SECONDS))
                assertEquals(frozenDefaultCount, defaultCalls.get())
            } finally {
                secondSyncReg.remove()
            }
        } finally {
            docListenerReg?.remove()
            defaultReg.remove()
            executorReg.remove()
        }
    }

    @Test
    @DisplayName("proves DocumentReference.get(source) across DEFAULT, SERVER, and CACHE online and offline (#14)")
    fun `proves DocumentReference get across DEFAULT, SERVER, and CACHE online and offline`() {
        val uncachedDoc = firestore.document("users/$uid/items/source-uncached")
        assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
            Tasks.await(uncachedDoc.get(Source.CACHE), 10, TimeUnit.SECONDS)
        }

        val absentDoc = firestore.document("users/$uid/items/source-absent")
        val absentServer = Tasks.await(absentDoc.get(Source.SERVER), 10, TimeUnit.SECONDS)
        assertFalse(absentServer.exists())
        assertFalse(absentServer.metadata.isFromCache)
        val absentCache = Tasks.await(absentDoc.get(Source.CACHE), 10, TimeUnit.SECONDS)
        assertFalse(absentCache.exists())
        assertTrue(absentCache.metadata.isFromCache)

        val presentDoc = firestore.document("users/$uid/items/source-present")
        Tasks.await(presentDoc.set(mapOf("title" to "Server Truth", "count" to 9L)), 10, TimeUnit.SECONDS)

        val defaultOnline = Tasks.await(presentDoc.get(Source.DEFAULT), 10, TimeUnit.SECONDS)
        assertTrue(defaultOnline.exists())
        assertFalse(defaultOnline.metadata.isFromCache)
        assertEquals("Server Truth", defaultOnline.getString("title"))

        val cacheOnline = Tasks.await(presentDoc.get(Source.CACHE), 10, TimeUnit.SECONDS)
        assertTrue(cacheOnline.exists())
        assertTrue(cacheOnline.metadata.isFromCache)
        assertEquals(9L, cacheOnline.getLong("count"))

        Tasks.await(firestore.disableNetwork(), 10, TimeUnit.SECONDS)
        try {
            assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
                Tasks.await(presentDoc.get(Source.SERVER), 10, TimeUnit.SECONDS)
            }
            val defaultOfflineFallback = Tasks.await(presentDoc.get(Source.DEFAULT), 10, TimeUnit.SECONDS)
            assertTrue(defaultOfflineFallback.exists())
            assertTrue(defaultOfflineFallback.metadata.isFromCache)
            assertEquals("Server Truth", defaultOfflineFallback.getString("title"))

            val neverSeenOffline = firestore.document("users/$uid/items/source-never-seen")
            assertFirestoreCode(FirebaseFirestoreException.Code.UNAVAILABLE) {
                Tasks.await(neverSeenOffline.get(Source.DEFAULT), 10, TimeUnit.SECONDS)
            }
        } finally {
            Tasks.await(firestore.enableNetwork(), 10, TimeUnit.SECONDS)
        }
    }

    @Test
    @DisplayName("proves DocumentReference set, merge/mergeFields, update(FieldPath), delete, and collection (#15-#19)")
    fun `proves DocumentReference set, merge, update FieldPath, delete, and collection`() {
        val userDoc = firestore.document("users/$uid")
        val itemsCol = userDoc.collection("/items/")
        assertEquals("users/$uid/items", itemsCol.path)
        assertEquals("items", itemsCol.id)
        assertEquals(userDoc, itemsCol.parent)

        val deepCol = userDoc.collection("threads/t-1/messages")
        assertEquals("users/$uid/threads/t-1/messages", deepCol.path)
        assertEquals("messages", deepCol.id)
        assertEquals("users/$uid/threads/t-1", deepCol.parent?.path)
        assertThrows(IllegalArgumentException::class.java) { userDoc.collection("") }
        assertThrows(IllegalArgumentException::class.java) { userDoc.collection("threads/t-1") }

        // Unauthorized child collection under userDoc is rejected by live Security Rules
        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(userDoc.collection("private_notes").document("n1").set(mapOf("x" to 1L)), 10, TimeUnit.SECONDS)
        }

        // #15: set(data) full overwrite + POJO round-trip + rules denial
        val docRef = itemsCol.document("crud-target")
        Tasks.await(docRef.set(mapOf("legacy" to "drop-me", "count" to 1L)), 10, TimeUnit.SECONDS)
        Tasks.await(docRef.set(mapOf("title" to "Overwritten", "count" to 2L)), 10, TimeUnit.SECONDS)
        val overwritten = Tasks.await(docRef.get(), 10, TimeUnit.SECONDS)
        assertNull(overwritten.get("legacy"))
        assertEquals("Overwritten", overwritten.getString("title"))
        assertEquals(2L, overwritten.getLong("count"))

        val pojoDoc = itemsCol.document("pojo-target")
        Tasks.await(
            pojoDoc.set(ProfileNote(docId = "ignored", headline = "Shipped", priority = 4L)),
            10,
            TimeUnit.SECONDS
        )
        val pojoSnap = Tasks.await(pojoDoc.get(), 10, TimeUnit.SECONDS)
        val hydrated = pojoSnap.toObject(ProfileNote::class.java)
        assertNotNull(hydrated)
        assertEquals("pojo-target", hydrated?.docId)
        assertEquals("Shipped", hydrated?.headline)
        assertEquals(4L, hydrated?.priority)
        assertNotNull(hydrated?.updatedAt)

        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(
                firestore.document("users/other-owner/items/forbidden").set(mapOf("a" to 1L)),
                10,
                TimeUnit.SECONDS
            )
        }

        // #16: set with SetOptions.merge(), SetOptions.mergeFields, and SetOptions.mergeFieldPaths
        Tasks.await(
            docRef.set(mapOf("meta" to mapOf("author" to "Ada", "tier" to "gold"), "views" to 10L), SetOptions.merge()),
            10, TimeUnit.SECONDS
        )
        Tasks.await(
            docRef.set(
                mapOf("meta" to mapOf("author" to "Grace", "unmasked" to "ignored"), "views" to 25L, "title" to "Ignored"),
                SetOptions.mergeFields("meta.author", "views")
            ),
            10, TimeUnit.SECONDS
        )
        Tasks.await(
            docRef.set(
                mapOf("meta" to mapOf("badge" to "verified", "extraIgnored" to true), "count" to 999L),
                SetOptions.mergeFieldPaths(listOf(FieldPath.of("meta", "badge")))
            ),
            10, TimeUnit.SECONDS
        )
        val mergedSnap = Tasks.await(docRef.get(), 10, TimeUnit.SECONDS)
        assertEquals("Overwritten", mergedSnap.getString("title"))
        assertEquals(2L, mergedSnap.getLong("count"))
        assertEquals(25L, mergedSnap.getLong("views"))
        assertEquals("Grace", mergedSnap.get(FieldPath.of("meta", "author")))
        assertEquals("gold", mergedSnap.get(FieldPath.of("meta", "tier")))
        assertEquals("verified", mergedSnap.get(FieldPath.of("meta", "badge")))
        assertNull(mergedSnap.get(FieldPath.of("meta", "unmasked")))
        assertNull(mergedSnap.get(FieldPath.of("meta", "extraIgnored")))

        // #17: update(Map), update(String varargs), update(FieldPath) with literal dot key, and NOT_FOUND
        assertThrows(IllegalArgumentException::class.java) { docRef.update("count", 3L, "danglingKey") }
        Tasks.await(docRef.update(mapOf("count" to 5L, "meta.tier" to "platinum")), 10, TimeUnit.SECONDS)
        Tasks.await(docRef.update("views", 30L, "meta.region", "us-central1"), 10, TimeUnit.SECONDS)
        Tasks.await(
            docRef.update(FieldPath.of("literal.dot", "leaf"), "kept-intact", FieldPath.of("count"), 8L),
            10, TimeUnit.SECONDS
        )
        val updatedSnap = Tasks.await(docRef.get(), 10, TimeUnit.SECONDS)
        assertEquals(8L, updatedSnap.getLong("count"))
        assertEquals(30L, updatedSnap.getLong("views"))
        assertEquals("platinum", updatedSnap.get(FieldPath.of("meta", "tier")))
        assertEquals("us-central1", updatedSnap.get(FieldPath.of("meta", "region")))
        assertEquals("kept-intact", updatedSnap.get(FieldPath.of("literal.dot", "leaf")))
        @Suppress("UNCHECKED_CAST")
        val literalDotMap = updatedSnap.getData()?.get("literal.dot") as? Map<String, Any?>
        assertEquals("kept-intact", literalDotMap?.get("leaf"))
        assertNull(updatedSnap.getData()?.get("literal"))

        assertFirestoreCode(FirebaseFirestoreException.Code.NOT_FOUND) {
            Tasks.await(itemsCol.document("does-not-exist").update("count", 1L), 10, TimeUnit.SECONDS)
        }

        // #18: delete() removes document from server and cache; forbidden delete fails with PERMISSION_DENIED
        Tasks.await(docRef.delete(), 10, TimeUnit.SECONDS)
        assertFalse(Tasks.await(docRef.get(Source.SERVER), 10, TimeUnit.SECONDS).exists())
        assertFalse(Tasks.await(docRef.get(Source.CACHE), 10, TimeUnit.SECONDS).exists())
        // Deleting an already-deleted document succeeds idempotently
        Tasks.await(docRef.delete(), 10, TimeUnit.SECONDS)
        assertFirestoreCode(FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            Tasks.await(firestore.document("users/other-owner/items/forbidden").delete(), 10, TimeUnit.SECONDS)
        }
    }

    @Test
    @DisplayName("proves DocumentReference.snapshots(metadataChanges) EXCLUDE vs INCLUDE and rules errors (#20)")
    fun `proves DocumentReference snapshots EXCLUDE vs INCLUDE and rules errors`() {
        val docRef = firestore.document("users/$uid/items/live-stream")
        Tasks.await(docRef.set(mapOf("step" to 1L)), 10, TimeUnit.SECONDS)

        val excludeEvents = CopyOnWriteArrayList<Pair<Long?, SnapshotMetadata>>()
        val includeEvents = CopyOnWriteArrayList<Pair<Long?, SnapshotMetadata>>()
        val initialReady = CountDownLatch(2)
        val offlineMetaReady = CountDownLatch(1)
        val offlineWriteReady = CountDownLatch(2)
        val onlineAckReady = CountDownLatch(1)
        val deletedReady = CountDownLatch(2)
        val scope = CoroutineScope(Dispatchers.IO)

        scope.launch {
            docRef.snapshots(MetadataChanges.EXCLUDE).collect { snap ->
                val pair = snap.getLong("step") to snap.metadata
                excludeEvents.add(pair)
                if (excludeEvents.size == 1) initialReady.countDown()
                if (snap.getLong("step") == 2L) offlineWriteReady.countDown()
                if (!snap.exists()) deletedReady.countDown()
            }
        }
        scope.launch {
            docRef.snapshots(MetadataChanges.INCLUDE).collect { snap ->
                val pair = snap.getLong("step") to snap.metadata
                includeEvents.add(pair)
                if (includeEvents.size == 1) initialReady.countDown()
                if (snap.getLong("step") == 1L && snap.metadata.isFromCache) offlineMetaReady.countDown()
                if (snap.getLong("step") == 2L && snap.metadata.hasPendingWrites) offlineWriteReady.countDown()
                if (snap.getLong("step") == 2L && !snap.metadata.isFromCache && !snap.metadata.hasPendingWrites) {
                    onlineAckReady.countDown()
                }
                if (!snap.exists()) deletedReady.countDown()
            }
        }

        try {
            assertTrue(initialReady.await(10, TimeUnit.SECONDS))
            assertEquals(1, excludeEvents.size)
            assertEquals(1L to SnapshotMetadata(hasPendingWrites = false, isFromCache = false), excludeEvents[0])

            // Going offline changes isFromCache from false -> true without changing data:
            // INCLUDE emits, while EXCLUDE suppresses the metadata-only transition.
            Tasks.await(firestore.disableNetwork(), 10, TimeUnit.SECONDS)
            assertTrue(offlineMetaReady.await(10, TimeUnit.SECONDS))
            assertEquals(1, excludeEvents.size)

            // Offline write mutates step to 2L: both EXCLUDE and INCLUDE emit immediately from local projection
            val offlineWriteTask = docRef.update("step", 2L)
            assertTrue(offlineWriteReady.await(10, TimeUnit.SECONDS))
            assertEquals(2, excludeEvents.size)
            assertEquals(2L, excludeEvents[1].first)
            assertTrue(excludeEvents[1].second.hasPendingWrites)

            // Reconnecting commits step=2L on host: INCLUDE emits clean server metadata, EXCLUDE suppresses duplicate
            Tasks.await(firestore.enableNetwork(), 10, TimeUnit.SECONDS)
            Tasks.await(offlineWriteTask, 10, TimeUnit.SECONDS)
            assertTrue(onlineAckReady.await(10, TimeUnit.SECONDS))
            assertEquals(2, excludeEvents.size)

            Tasks.await(docRef.delete(), 10, TimeUnit.SECONDS)
            assertTrue(deletedReady.await(10, TimeUnit.SECONDS))
            assertEquals(3, excludeEvents.size)
            assertNull(excludeEvents[2].first)
        } finally {
            scope.cancel()
        }

        // Security Rules denial surfaces FirebaseFirestoreException(PERMISSION_DENIED) on snapshots() Flow
        val capturedError = AtomicReference<Throwable?>(null)
        runBlocking {
            firestore.document("users/another-user/items/denied-stream")
                .snapshots()
                .catch { e -> capturedError.set(e) }
                .collect { }
        }
        val fse = capturedError.get() as? FirebaseFirestoreException
            ?: fail("Expected FirebaseFirestoreException on denied snapshots(), got: ${capturedError.get()}")
        assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, fse.code)
    }

    private fun assertFirestoreCode(expected: FirebaseFirestoreException.Code, block: () -> Unit) {
        try {
            block()
            fail("Expected FirebaseFirestoreException($expected)")
        } catch (err: ExecutionException) {
            val cause = err.cause as? FirebaseFirestoreException
                ?: fail("Expected FirebaseFirestoreException cause, got: ${err.cause}")
            assertEquals(expected, cause.code)
        }
    }

    companion object {
        private const val DEFAULT_PROJECT_ID = "demo-kotlin-live"
        private const val USER_PASSWORD = "live-firestore-password-123"
    }
}
