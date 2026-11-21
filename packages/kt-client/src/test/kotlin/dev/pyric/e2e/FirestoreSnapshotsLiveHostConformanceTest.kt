package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.firestore.ServerTimestamp
import com.google.firebase.firestore.toObject
import com.google.firebase.firestore.toObjects
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class FirestoreSnapshotsLiveHostConformanceTest {
    data class RoomRecord(
        @DocumentId var roomId: String = "",
        var title: String = "",
        var capacity: Long = 0L,
        var active: Boolean = false,
        @ServerTimestamp var updatedAt: Timestamp? = null
    )

    data class LinkedItemRecord(
        @DocumentId var ref: DocumentReference? = null,
        var label: String = "",
        var rank: Int = 0
    )

    private val extraClients = CopyOnWriteArrayList<PyricBridgeClient>()
    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var liveBridgeUrl: String
    private lateinit var projectId: String
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var moderatorUid: String

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

        val moderatorToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
        val signedIn = Tasks.await(auth.signInWithCustomToken(moderatorToken), 10, TimeUnit.SECONDS)
        moderatorUid = requireNotNull(signedIn.user).uid
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
        bridgeClient = null
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("rows #39-#42: proves DocumentSnapshot exists, revived getData defensive copies, FieldPath get, and POJO toObject/toObjects")
    fun `proves DocumentSnapshot exists, getData, FieldPath get, and toObject over live host`() {
        val prefix = "snap-${System.nanoTime()}"
        val missingRef = firestore.document("role_items/moderator/items/$prefix-missing")
        val missingSnap = Tasks.await(missingRef.get(), 10, TimeUnit.SECONDS)
        assertFalse(missingSnap.exists())
        assertNull(missingSnap.getData())
        assertNull(missingSnap.get("title"))
        assertFalse(missingSnap.contains("title"))
        assertNull(missingSnap.toObject<RoomRecord>())

        val targetRef = firestore.document("users/$moderatorUid")
        val linkedRef = firestore.document("role_items/moderator/items/$prefix-linked")
        val eventTime = Timestamp(1_715_000_000L, 125_000_000)
        val geo = GeoPoint(35.6762, 139.6503)
        val rawBytes = byteArrayOf(0x01, 0x02, 0x7F)

        Tasks.await(
            targetRef.set(
                mapOf(
                    "title" to "Control Room",
                    "capacity" to 12L,
                    "active" to true,
                    "nullableNote" to null,
                    "eventTime" to eventTime,
                    "coords" to geo,
                    "payload" to Blob.fromBytes(rawBytes),
                    "linked" to linkedRef,
                    "stats" to mapOf("floor" to 3L, "zone" to "north"),
                    "meta.v1" to "top-level-dotted"
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        val snap = Tasks.await(targetRef.get(), 10, TimeUnit.SECONDS)
        assertTrue(snap.exists())
        assertTrue(snap.contains("title"))
        assertTrue(snap.contains("nullableNote"))
        assertTrue(snap.contains("stats.zone"))
        assertTrue(snap.contains(FieldPath.of("meta.v1")))
        assertFalse(snap.contains("stats.nonexistent"))

        val dataMap = requireNotNull(snap.getData())
        assertEquals("Control Room", dataMap["title"])
        assertEquals(12L, dataMap["capacity"])
        assertEquals("java.lang.Long", requireNotNull(dataMap["capacity"])::class.java.name)
        @Suppress("UNCHECKED_CAST")
        val nestedStats = dataMap["stats"] as Map<String, Any?>
        assertEquals(3L, nestedStats["floor"])
        assertEquals("java.lang.Long", requireNotNull(nestedStats["floor"])::class.java.name)
        assertEquals(eventTime, dataMap["eventTime"])
        assertEquals(geo, dataMap["coords"])
        assertArrayEquals(rawBytes, (dataMap["payload"] as Blob).toBytes())
        assertEquals(linkedRef.path, (dataMap["linked"] as DocumentReference).path)

        if (dataMap is MutableMap<*, *>) {
            @Suppress("UNCHECKED_CAST")
            (dataMap as MutableMap<String, Any?>)["title"] = "Tampered"
        }
        assertEquals("Control Room", snap.getString("title"))
        assertEquals(12L, snap.get("capacity"))
        assertEquals("java.lang.Long", requireNotNull(snap.get("capacity"))::class.java.name)
        assertEquals("north", snap.getString("stats.zone"))
        assertEquals(3L, snap.get(FieldPath.of("stats", "floor")))
        assertEquals("java.lang.Long", requireNotNull(snap.get(FieldPath.of("stats", "floor")))::class.java.name)
        assertEquals(3L, snap.getLong(FieldPath.of("stats", "floor")))
        assertEquals("top-level-dotted", snap.getString(FieldPath.of("meta.v1")))
        assertNull(snap.get("nullableNote"))

        val pojoDoc = firestore.document("role_items/moderator/items/$prefix-room")
        Tasks.await(
            pojoDoc.set(RoomRecord(roomId = "ignored", title = "Summit", capacity = 24L, active = true)),
            10,
            TimeUnit.SECONDS
        )
        val pojoSnap = Tasks.await(pojoDoc.get(), 10, TimeUnit.SECONDS)
        val room = requireNotNull(pojoSnap.toObject<RoomRecord>())
        assertEquals("$prefix-room", room.roomId)
        assertEquals("Summit", room.title)
        assertEquals(24L, room.capacity)
        assertTrue(room.active)
        assertNotNull(room.updatedAt)

        val listCol = firestore.collection("role_items/moderator/items")
        Tasks.await(
            listCol.document("$prefix-l1").set(mapOf("group" to prefix, "label" to "First", "rank" to 1)),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            listCol.document("$prefix-l2").set(mapOf("group" to prefix, "label" to "Second", "rank" to 2)),
            10,
            TimeUnit.SECONDS
        )
        val querySnap = Tasks.await(
            listCol.whereEqualTo("group", prefix).orderBy("rank", Query.Direction.ASCENDING).get(),
            10,
            TimeUnit.SECONDS
        )
        val mapped = querySnap.toObjects<LinkedItemRecord>()
        assertEquals(2, mapped.size)
        assertEquals(listOf("First", "Second"), mapped.map { it.label })
        assertEquals(
            listOf(
                "role_items/moderator/items/$prefix-l1",
                "role_items/moderator/items/$prefix-l2"
            ),
            mapped.map { it.ref?.path }
        )
    }

    @Test
    @DisplayName("rows #43-#44: proves QuerySnapshot documentChanges diffing and SnapshotMetadata transitions across live host")
    fun `proves QuerySnapshot documentChanges and SnapshotMetadata transitions across live host`() {
        val prefix = "changes-${System.nanoTime()}"
        val itemsCol = firestore.collection("role_items/moderator/items")
        val docA = itemsCol.document("$prefix-a")
        val docB = itemsCol.document("$prefix-b")
        val docC = itemsCol.document("$prefix-c")

        Tasks.await(docA.set(mapOf("group" to prefix, "score" to 10L)), 10, TimeUnit.SECONDS)
        Tasks.await(docB.set(mapOf("group" to prefix, "score" to 20L)), 10, TimeUnit.SECONDS)

        val query = itemsCol.whereEqualTo("group", prefix).orderBy("score", Query.Direction.ASCENDING)
        val oneShot = Tasks.await(query.get(), 10, TimeUnit.SECONDS)
        assertFalse(oneShot.metadata.hasPendingWrites)
        assertFalse(oneShot.metadata.isFromCache)
        assertEquals(listOf("$prefix-a", "$prefix-b"), oneShot.documents.map { it.id })
        assertEquals(
            listOf(
                Triple(DocumentChange.Type.ADDED, -1, 0),
                Triple(DocumentChange.Type.ADDED, -1, 1)
            ),
            oneShot.documentChanges.map { Triple(it.type, it.oldIndex, it.newIndex) }
        )
        assertEquals(oneShot.documentChanges, oneShot.getDocumentChanges(MetadataChanges.INCLUDE))

        val snapshots = CopyOnWriteArrayList<QuerySnapshot>()
        val step1 = CountDownLatch(1)
        val step2 = CountDownLatch(2)
        val step3 = CountDownLatch(3)
        val step4 = CountDownLatch(4)

        val reg = query.addSnapshotListener(MetadataChanges.EXCLUDE) { qs, err ->
            if (err == null && qs != null) {
                snapshots.add(qs)
                step1.countDown()
                step2.countDown()
                step3.countDown()
                step4.countDown()
            }
        }
        try {
            assertTrue(step1.await(10, TimeUnit.SECONDS))
            assertThrows(IllegalArgumentException::class.java) {
                snapshots[0].getDocumentChanges(MetadataChanges.INCLUDE)
            }
            assertEquals(2, snapshots[0].documentChanges.size)
            assertTrue(snapshots[0].documentChanges.all { it.type == DocumentChange.Type.ADDED })

            Tasks.await(docC.set(mapOf("group" to prefix, "score" to 15L)), 10, TimeUnit.SECONDS)
            assertTrue(step2.await(10, TimeUnit.SECONDS))
            val addChanges = snapshots[1].documentChanges
            assertEquals(1, addChanges.size)
            assertEquals(DocumentChange.Type.ADDED, addChanges[0].type)
            assertEquals("$prefix-c", addChanges[0].document.id)
            assertEquals(-1, addChanges[0].oldIndex)
            assertEquals(1, addChanges[0].newIndex)

            Tasks.await(docA.update("score", 30L), 10, TimeUnit.SECONDS)
            assertTrue(step3.await(10, TimeUnit.SECONDS))
            val modChanges = snapshots[2].documentChanges
            assertEquals(1, modChanges.size)
            assertEquals(DocumentChange.Type.MODIFIED, modChanges[0].type)
            assertEquals("$prefix-a", modChanges[0].document.id)
            assertEquals(0, modChanges[0].oldIndex)
            assertEquals(2, modChanges[0].newIndex)

            Tasks.await(docC.delete(), 10, TimeUnit.SECONDS)
            assertTrue(step4.await(10, TimeUnit.SECONDS))
            val remChanges = snapshots[3].documentChanges
            assertEquals(1, remChanges.size)
            assertEquals(DocumentChange.Type.REMOVED, remChanges[0].type)
            assertEquals("$prefix-c", remChanges[0].document.id)
            assertEquals(0, remChanges[0].oldIndex)
            assertEquals(-1, remChanges[0].newIndex)
        } finally {
            reg.remove()
        }

        LoopbackTcpRelay(URI(liveBridgeUrl)).use { relay ->
            val relayApp = FirebaseApp.initializeApp(
                "relay-app-${System.nanoTime()}",
                FirebaseOptions.Builder()
                    .setProjectId(projectId)
                    .setApiKey("demo-firestore-api-key")
                    .setApplicationId("1:424242424242:android:kotlinfirestore")
                    .build()
            )
            val relayClient = PyricBridgeClient(
                url = relay.relayWsUrl,
                reconnectDelayMs = { 40L }
            )
            extraClients.add(relayClient)
            val relayAuth = FirebaseAuth.getInstance(relayApp, relayClient)
            val relayFs = FirebaseFirestore.getInstance(relayApp, relayClient)
            val modToken = requireNotNull(System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID"))
            Tasks.await(relayAuth.signInWithCustomToken(modToken), 10, TimeUnit.SECONDS)

            val includeSnaps = CopyOnWriteArrayList<QuerySnapshot>()
            val excludeSnaps = CopyOnWriteArrayList<QuerySnapshot>()
            val initialBoth = CountDownLatch(2)
            val cachedReady = CountDownLatch(1)
            val reattachedReady = CountDownLatch(1)

            val relayQuery = relayFs.collection("role_items/moderator/items")
                .whereEqualTo("group", prefix)
                .orderBy("score", Query.Direction.ASCENDING)

            val incReg = relayQuery.addSnapshotListener(MetadataChanges.INCLUDE) { qs, err ->
                if (err == null && qs != null) {
                    includeSnaps.add(qs)
                    if (includeSnaps.size == 1) initialBoth.countDown()
                    if (qs.metadata.isFromCache) cachedReady.countDown()
                    if (includeSnaps.size >= 3 && !qs.metadata.isFromCache) reattachedReady.countDown()
                }
            }
            val excReg = relayQuery.addSnapshotListener(MetadataChanges.EXCLUDE) { qs, err ->
                if (err == null && qs != null) {
                    excludeSnaps.add(qs)
                    if (excludeSnaps.size == 1) initialBoth.countDown()
                }
            }
            try {
                assertTrue(initialBoth.await(10, TimeUnit.SECONDS))
                assertFalse(includeSnaps[0].metadata.isFromCache)

                relay.dropActiveConnections()
                assertTrue(cachedReady.await(10, TimeUnit.SECONDS))
                assertTrue(reattachedReady.await(10, TimeUnit.SECONDS))

                val cachedSnap = includeSnaps.first { it.metadata.isFromCache }
                assertTrue(cachedSnap.documents.all { it.metadata.isFromCache })
                assertTrue(cachedSnap.getDocumentChanges(MetadataChanges.EXCLUDE).isEmpty())
                assertEquals(2, cachedSnap.getDocumentChanges(MetadataChanges.INCLUDE).size)
                assertTrue(
                    cachedSnap.getDocumentChanges(MetadataChanges.INCLUDE)
                        .all { it.type == DocumentChange.Type.MODIFIED }
                )

                assertFalse(includeSnaps.last().metadata.isFromCache)
                assertEquals(1, excludeSnaps.size)
            } finally {
                incReg.remove()
                excReg.remove()
            }
        }
    }

    private class LoopbackTcpRelay(upstreamWsUri: URI) : AutoCloseable {
        private val upstreamHost = upstreamWsUri.host
        private val upstreamPort = upstreamWsUri.port
        private val serverSocket = ServerSocket(0, 16, InetSocketAddress("127.0.0.1", 0).address)
        private val activeSockets = CopyOnWriteArrayList<Socket>()
        private val closed = AtomicBoolean(false)

        val relayWsUrl: String =
            "ws://127.0.0.1:${serverSocket.localPort}${upstreamWsUri.rawPath}"

        init {
            Thread({
                while (!closed.get()) {
                    val inbound = try {
                        serverSocket.accept()
                    } catch (_: Exception) {
                        break
                    }
                    val outbound = try {
                        Socket(upstreamHost, upstreamPort)
                    } catch (_: Exception) {
                        runCatching { inbound.close() }
                        continue
                    }
                    activeSockets.add(inbound)
                    activeSockets.add(outbound)
                    pipeAsync(inbound.getInputStream(), outbound.getOutputStream(), inbound, outbound)
                    pipeAsync(outbound.getInputStream(), inbound.getOutputStream(), outbound, inbound)
                }
            }, "pyric-live-tcp-relay").apply {
                isDaemon = true
                start()
            }
        }

        fun dropActiveConnections() {
            val snapshot = activeSockets.toList()
            activeSockets.clear()
            for (sock in snapshot) {
                runCatching { sock.close() }
            }
        }

        override fun close() {
            if (closed.compareAndSet(false, true)) {
                runCatching { serverSocket.close() }
                dropActiveConnections()
            }
        }

        private fun pipeAsync(input: InputStream, output: OutputStream, primary: Socket, peer: Socket) {
            Thread({
                val buf = ByteArray(8192)
                try {
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        output.flush()
                    }
                } catch (_: Exception) {
                } finally {
                    runCatching { primary.close() }
                    runCatching { peer.close() }
                }
            }, "pyric-relay-pipe").apply {
                isDaemon = true
                start()
            }
        }
    }
}
