package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.fail
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class FirestoreQueriesLiveHostConformanceTest {
    private val extraClients = CopyOnWriteArrayList<PyricBridgeClient>()
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
        projectId = System.getenv("PYRIC_LIVE_FIRESTORE_PROJECT_ID") ?: "demo-kotlin-firestore"
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

        val email = "queries-${UUID.randomUUID()}@example.com"
        val authRes = Tasks.await(
            auth.createUserWithEmailAndPassword(email, "CorrectHorse!21"),
            10,
            TimeUnit.SECONDS
        )
        uid = requireNotNull(authRes.user).uid
    }

    @AfterEach
    fun tearDown() {
        for (extra in extraClients) {
            runBlocking { extra.disconnect() }
        }
        extraClients.clear()
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun seedDataset(collectionPath: String) {
        val coll = firestore.collection(collectionPath)
        val batch = firestore.batch()
        batch.set(
            coll.document("doc-a"),
            mapOf(
                "category" to "books",
                "score" to 10L,
                "tags" to listOf("kotlin", "mobile"),
                "active" to true,
                "createdAt" to Timestamp(1_700_000_100L, 0),
                "meta.tier" to mapOf("rank" to 1L),
                "envelope" to mapOf("type" to "order", "id" to "a", "path" to "/orders/a")
            )
        )
        batch.set(
            coll.document("doc-b"),
            mapOf(
                "category" to "books",
                "score" to 20L,
                "tags" to listOf("kotlin", "cloud"),
                "active" to true,
                "createdAt" to Timestamp(1_700_000_200L, 0),
                "meta.tier" to mapOf("rank" to 2L)
            )
        )
        batch.set(
            coll.document("doc-c"),
            mapOf(
                "category" to "games",
                "score" to 20L,
                "tags" to listOf("arcade"),
                "active" to false,
                "createdAt" to Timestamp(1_700_000_300L, 0),
                "meta.tier" to mapOf("rank" to 3L)
            )
        )
        batch.set(
            coll.document("doc-d"),
            mapOf(
                "category" to "music",
                "score" to 40L,
                "tags" to listOf("synth", "cloud"),
                "active" to true,
                "createdAt" to Timestamp(1_700_000_400L, 0),
                "meta.tier" to mapOf("rank" to 4L)
            )
        )
        Tasks.await(batch.commit(), 10, TimeUnit.SECONDS)
    }

    @Test
    @DisplayName("firestore-kotlin#21-#28: Live-host scalar, range, array, set, literal-dot FieldPath, and composite Filter queries")
    fun scalarRangeArraySetAndCompositeFiltersOnLiveHost() {
        val path = "users/$uid/items"
        seedDataset(path)
        val coll = firestore.collection(path)

        // #21 whereEqualTo (including FieldPath with literal dot segment)
        val eqSnap = Tasks.await(coll.whereEqualTo("category", "books").get(), 10, TimeUnit.SECONDS)
        assertEquals(setOf("doc-a", "doc-b"), eqSnap.documents.map { it.id }.toSet())

        val dottedField = FieldPath.of("meta.tier", "rank")
        val dottedEq = Tasks.await(coll.whereEqualTo(dottedField, 3L).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-c"), dottedEq.documents.map { it.id })

        val markerMapEq = Tasks.await(
            coll.whereEqualTo(
                "envelope",
                mapOf("type" to "order", "id" to "a", "path" to "/orders/a")
            ).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a"), markerMapEq.documents.map { it.id })

        // #22 whereNotEqualTo
        val neqSnap = Tasks.await(
            coll.whereNotEqualTo("category", "books").orderBy("category").get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-c", "doc-d"), neqSnap.documents.map { it.id })

        // #23 whereLessThan / whereLessThanOrEqualTo / whereGreaterThan / whereGreaterThanOrEqualTo
        val ltSnap = Tasks.await(coll.whereLessThan("score", 20L).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-a"), ltSnap.documents.map { it.id })

        val lteSnap = Tasks.await(
            coll.whereLessThanOrEqualTo("score", 20L).orderBy("score").get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a", "doc-b", "doc-c"), lteSnap.documents.map { it.id })

        val gtSnap = Tasks.await(coll.whereGreaterThan("score", 20L).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-d"), gtSnap.documents.map { it.id })

        val gteTsSnap = Tasks.await(
            coll.whereGreaterThanOrEqualTo("createdAt", Timestamp(1_700_000_300L, 0))
                .orderBy("createdAt")
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-c", "doc-d"), gteTsSnap.documents.map { it.id })

        // #24 whereArrayContains
        val arrayContains = Tasks.await(
            coll.whereArrayContains("tags", "kotlin").orderBy(FieldPath.documentId()).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a", "doc-b"), arrayContains.documents.map { it.id })

        // #25 whereArrayContainsAny
        val arrayContainsAny = Tasks.await(
            coll.whereArrayContainsAny("tags", listOf("arcade", "synth"))
                .orderBy(FieldPath.documentId())
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-c", "doc-d"), arrayContainsAny.documents.map { it.id })

        // #26 whereIn (including FieldPath.documentId())
        val inSnap = Tasks.await(
            coll.whereIn("category", listOf("games", "music")).orderBy(FieldPath.documentId()).get(),
            10, TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-c", "doc-d"), inSnap.documents.map { it.id })

        val docIdIn = Tasks.await(
            coll.whereIn(FieldPath.documentId(), listOf("doc-a", "doc-d")).orderBy(FieldPath.documentId()).get(),
            10, TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a", "doc-d"), docIdIn.documents.map { it.id })

        // #27 whereNotIn
        val notInSnap = Tasks.await(coll.whereNotIn("category", listOf("books", "games")).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-d"), notInSnap.documents.map { it.id })

        // #28 Composite Filter.and + Filter.or
        val composite = Tasks.await(
            coll.where(
                Filter.and(
                    Filter.equalTo("active", true),
                    Filter.or(
                        Filter.equalTo("category", "music"),
                        Filter.lessThanOrEqualTo("score", 15L)
                    )
                )
            ).orderBy("score").get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a", "doc-d"), composite.documents.map { it.id })
    }

    @Test
    @DisplayName("firestore-kotlin#29-#34: Live-host orderBy, limit, limitToLast, value cursors, and DocumentSnapshot cursors")
    fun orderingLimitsValueCursorsAndSnapshotCursorsOnLiveHost() {
        val path = "users/$uid/items"
        seedDataset(path)
        val coll = firestore.collection(path)

        // #29 orderBy asc/desc + literal-dot FieldPath + FieldPath.documentId()
        val descByScore = Tasks.await(
            coll.orderBy("score", Query.Direction.DESCENDING)
                .orderBy(FieldPath.documentId(), Query.Direction.DESCENDING)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-d", "doc-c", "doc-b", "doc-a"), descByScore.documents.map { it.id })

        val ascByDotted = Tasks.await(
            coll.orderBy(FieldPath.of("meta.tier", "rank"), Query.Direction.DESCENDING).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-d", "doc-c", "doc-b", "doc-a"), ascByDotted.documents.map { it.id })

        // #30 limit & #31 limitToLast
        val firstTwo = Tasks.await(
            coll.orderBy("score").orderBy(FieldPath.documentId()).limit(2).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-a", "doc-b"), firstTwo.documents.map { it.id })

        val lastTwo = Tasks.await(
            coll.orderBy("score").orderBy(FieldPath.documentId()).limitToLast(2).get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-c", "doc-d"), lastTwo.documents.map { it.id })

        // #32 startAt / startAfter & #33 endAt / endBefore with field values and DocumentReference
        val valueWindow = Tasks.await(
            coll.orderBy("createdAt")
                .startAt(Timestamp(1_700_000_200L, 0))
                .endBefore(Timestamp(1_700_000_400L, 0))
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-b", "doc-c"), valueWindow.documents.map { it.id })

        val docIdWindow = Tasks.await(
            coll.orderBy(FieldPath.documentId())
                .startAfter(coll.document("doc-a"))
                .endAt("doc-c")
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(listOf("doc-b", "doc-c"), docIdWindow.documents.map { it.id })

        // #34 DocumentSnapshot cursors:
        // (a) Tie-breaking between doc-b (score=20) and doc-c (score=20) via implicit __name__ reference!
        val snapB = Tasks.await(coll.document("doc-b").get(), 10, TimeUnit.SECONDS)
        val snapC = Tasks.await(coll.document("doc-c").get(), 10, TimeUnit.SECONDS)

        val afterSnapB = Tasks.await(coll.orderBy("score").startAfter(snapB).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-c", "doc-d"), afterSnapB.documents.map { it.id })

        val betweenSnapBandC = Tasks.await(coll.orderBy("score").startAt(snapB).endAt(snapC).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-b", "doc-c"), betweenSnapBandC.documents.map { it.id })

        val beforeSnapC = Tasks.await(coll.orderBy("score").endBefore(snapC).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-a", "doc-b"), beforeSnapC.documents.map { it.id })

        // (b) DocumentSnapshot cursor WITHOUT explicit orderBy (orders implicitly by __name__ asc)
        val noExplicitOrder = Tasks.await(coll.startAfter(snapB).endAt(snapC).get(), 10, TimeUnit.SECONDS)
        assertEquals(listOf("doc-c"), noExplicitOrder.documents.map { it.id })
    }

    @Test
    @DisplayName("firestore-kotlin#35-#36: Live-host Query.get(source), Query.snapshots(metadataChanges), and Security Rules denial")
    fun queryGetSourcesSnapshotsFlowAndSecurityRulesOnLiveHost() {
        val uri = URI.create(liveBridgeUrl)
        val upstreamPort = uri.port
        val upstreamHost = uri.host ?: "127.0.0.1"

        LoopbackWsRelay(upstreamHost, upstreamPort).use { relay ->
            val relayUrl = "ws://127.0.0.1:${relay.localPort}${uri.rawPath}"
            val relayApp = FirebaseApp.initializeApp(
                "relay-queries-app",
                FirebaseOptions.Builder()
                    .setProjectId(projectId)
                    .setApiKey("demo-firestore-api-key")
                    .setApplicationId("1:424242424242:android:kotlinfirestore")
                    .build()
            )
            val relayBridge = PyricBridgeClient(
                url = relayUrl,
                reconnectDelayMs = { 150L }
            ).apply {
                holdTimeoutMs = 1_000L
            }
            extraClients.add(relayBridge)
            val relayAuth = FirebaseAuth.getInstance(relayApp, relayBridge)
            val relayDb = FirebaseFirestore.getInstance(relayApp, relayBridge)
            Tasks.await(
                relayAuth.signInWithEmailAndPassword(
                    requireNotNull(auth.currentUser?.email),
                    "CorrectHorse!21"
                ),
                10,
                TimeUnit.SECONDS
            )

            val path = "users/$uid/items"
            seedDataset(path)
            val query = relayDb.collection(path).whereEqualTo("active", true).orderBy("score")

            // #35 Cold Source.CACHE returns empty snapshot with isFromCache = true
            val coldCache = Tasks.await(query.get(Source.CACHE), 5, TimeUnit.SECONDS)
            assertTrue(coldCache.isEmpty)
            assertTrue(coldCache.metadata.isFromCache)

            // #35 Source.DEFAULT fetches live server results (isFromCache = false) and warms cache
            val defaultSnap = Tasks.await(query.get(Source.DEFAULT), 10, TimeUnit.SECONDS)
            assertEquals(listOf("doc-a", "doc-b", "doc-d"), defaultSnap.documents.map { it.id })
            assertFalse(defaultSnap.metadata.isFromCache)

            // Mutate server via primary client; relayDb Source.CACHE still returns cached snapshot
            Tasks.await(
                firestore.document("$path/doc-a").update("score", 99L),
                10,
                TimeUnit.SECONDS
            )
            val cachedBeforeRefresh = Tasks.await(query.get(Source.CACHE), 5, TimeUnit.SECONDS)
            assertEquals(listOf("doc-a", "doc-b", "doc-d"), cachedBeforeRefresh.documents.map { it.id })
            assertTrue(cachedBeforeRefresh.metadata.isFromCache)

            // Source.SERVER fetches updated server order (doc-b, doc-d, doc-a)
            val refreshed = Tasks.await(query.get(Source.SERVER), 10, TimeUnit.SECONDS)
            assertEquals(listOf("doc-b", "doc-d", "doc-a"), refreshed.documents.map { it.id })
            assertFalse(refreshed.metadata.isFromCache)

            // #36 Query.snapshots(MetadataChanges.INCLUDE) emits live updates + cache transition on drop
            val scope = CoroutineScope(Dispatchers.IO)
            val initialLatch = CountDownLatch(1)
            val addedLatch = CountDownLatch(1)
            val cachedDropLatch = CountDownLatch(1)
            val observedChanges = CopyOnWriteArrayList<List<Pair<DocumentChange.Type, String>>>()

            val job = scope.launch {
                query.snapshots(MetadataChanges.INCLUDE).collect { snap ->
                    if (snap.metadata.isFromCache) {
                        cachedDropLatch.countDown()
                    } else {
                        observedChanges.add(
                            snap.getDocumentChanges(MetadataChanges.EXCLUDE).map { it.type to it.document.id }
                        )
                        if (observedChanges.size == 1) {
                            initialLatch.countDown()
                        } else if (snap.documents.any { it.id == "doc-e" }) {
                            addedLatch.countDown()
                        }
                    }
                }
            }

            try {
                assertTrue(initialLatch.await(10, TimeUnit.SECONDS), "Initial snapshots() emission")
                Tasks.await(
                    firestore.document("$path/doc-e").set(mapOf("active" to true, "score" to 5L)),
                    10,
                    TimeUnit.SECONDS
                )
                assertTrue(addedLatch.await(10, TimeUnit.SECONDS), "Live ADDED emission on snapshots()")
                assertTrue(
                    observedChanges.any { changes -> changes == listOf(DocumentChange.Type.ADDED to "doc-e") }
                )

                // Drop upstream sockets and block new connections briefly:
                // snapshots(INCLUDE) emits cached frame, Source.SERVER fails UNAVAILABLE, Source.DEFAULT falls back to cache!
                relay.pauseAndDropActiveConnections()
                assertTrue(cachedDropLatch.await(10, TimeUnit.SECONDS), "isFromCache emission on drop")

                val serverOfflineEx = assertThrows(ExecutionException::class.java) {
                    Tasks.await(query.get(Source.SERVER), 10, TimeUnit.SECONDS)
                }
                val fseServer = serverOfflineEx.cause as FirebaseFirestoreException
                assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, fseServer.code)

                val fallbackSnap = Tasks.await(query.get(Source.DEFAULT), 10, TimeUnit.SECONDS)
                assertTrue(fallbackSnap.metadata.isFromCache)
                assertTrue(fallbackSnap.documents.any { it.id == "doc-e" })

                relay.resumeAccepting()
            } finally {
                job.cancel()
                scope.cancel()
            }
        }

        // Security Rules denial on unauthorized user subpath query
        val otherUserQuery = firestore.collection("users/other-uid/items").whereEqualTo("active", true)
        val rulesEx = assertThrows(ExecutionException::class.java) {
            Tasks.await(otherUserQuery.get(), 10, TimeUnit.SECONDS)
        }
        val rulesFse = rulesEx.cause as? FirebaseFirestoreException
            ?: fail("Expected FirebaseFirestoreException, got ${rulesEx.cause}")
        assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, rulesFse.code)

        // Persistence disabled + Source.CACHE throws UNAVAILABLE
        val noPersistApp = FirebaseApp.initializeApp(
            "no-persist-live-app",
            FirebaseOptions.Builder()
                .setProjectId(projectId)
                .setApiKey("demo-firestore-api-key")
                .setApplicationId("1:424242424242:android:kotlinfirestore")
                .build()
        )
        val noPersistDb = FirebaseFirestore.getInstance(noPersistApp, requireNotNull(bridgeClient))
        noPersistDb.firestoreSettings = FirebaseFirestoreSettings.Builder()
            .setPersistenceEnabled(false)
            .build()
        val noPersistEx = assertThrows(ExecutionException::class.java) {
            Tasks.await(noPersistDb.collection("users/$uid/items").get(Source.CACHE), 5, TimeUnit.SECONDS)
        }
        assertEquals(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            (noPersistEx.cause as FirebaseFirestoreException).code
        )
    }

    private class LoopbackWsRelay(
        private val upstreamHost: String,
        private val upstreamPort: Int
    ) : AutoCloseable {
        private val serverSocket = ServerSocket(0, 50)
        private val running = AtomicBoolean(true)
        private val paused = AtomicBoolean(false)
        private val activeSockets = CopyOnWriteArrayList<Socket>()
        val localPort: Int = serverSocket.localPort

        private val acceptThread = Thread {
            while (running.get()) {
                val clientSock = try {
                    serverSocket.accept()
                } catch (_: Exception) {
                    break
                }
                if (paused.get()) {
                    runCatching { clientSock.close() }
                    continue
                }
                val upstreamSock = try {
                    Socket().apply { connect(InetSocketAddress(upstreamHost, upstreamPort), 2_000) }
                } catch (_: Exception) {
                    runCatching { clientSock.close() }
                    continue
                }
                activeSockets.add(clientSock)
                activeSockets.add(upstreamSock)
                pipeAsync(clientSock, upstreamSock)
                pipeAsync(upstreamSock, clientSock)
            }
        }.apply {
            isDaemon = true
            start()
        }

        private fun pipeAsync(src: Socket, dst: Socket) {
            Thread {
                try {
                    val input: InputStream = src.getInputStream()
                    val output: OutputStream = dst.getOutputStream()
                    val buf = ByteArray(8192)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        output.flush()
                    }
                } catch (_: Exception) {
                } finally {
                    runCatching { src.close() }
                    runCatching { dst.close() }
                }
            }.apply {
                isDaemon = true
                start()
            }
        }

        fun pauseAndDropActiveConnections() {
            paused.set(true)
            for (s in activeSockets) {
                runCatching { s.close() }
            }
            activeSockets.clear()
        }

        fun resumeAccepting() {
            paused.set(false)
        }

        override fun close() {
            running.set(false)
            runCatching { serverSocket.close() }
            pauseAndDropActiveConnections()
            acceptThread.join(1_000)
        }
    }
}
