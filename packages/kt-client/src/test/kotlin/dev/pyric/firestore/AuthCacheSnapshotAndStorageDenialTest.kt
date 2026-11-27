package dev.pyric.firestore

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.EventListener
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.QueryCacheStore
import com.google.firebase.firestore.QuerySnapshot
import com.google.firebase.firestore.SnapshotMetadata
import com.google.firebase.firestore.Source
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class AuthCacheSnapshotAndStorageDenialTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    private val subRecords = CopyOnWriteArrayList<Pair<String, Map<String, Any?>>>()
    private val itemStep = AtomicLong(1L)

    @BeforeEach
    fun setUp() {
        subRecords.clear()
        itemStep.set(1L)
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        transport = InMemoryBridgeTransport()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"] as? String) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String
                    @Suppress("UNCHECKED_CAST")
                    val actAs = op["actAs"] as? Map<String, Any?>
                    val uid = actAs?.get("uid") as? String
                    val mode = actAs?.get("mode") as? String

                    when (method) {
                        "storage.getMetadata" -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to false,
                                        "error" to mapOf(
                                            "code" to "storage/unauthorized",
                                            "message" to "storage/unauthorized: Get \"audio/alice/clip.wav\" denied by rules."
                                        )
                                    )
                                )
                            )
                        }
                        "storage.getDownloadURL" -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to false,
                                        "error" to mapOf(
                                            "code" to "storage/object-not-found",
                                            "message" to "storage/object-not-found: missing."
                                        )
                                    )
                                )
                            )
                        }
                        "getDoc" -> {
                            if (uid == "alice-uid" || mode == "admin") {
                                transport.sendToClient(
                                    JsonCodec.encodeToString(
                                        mapOf(
                                            "type" to "worker-res",
                                            "id" to id,
                                            "ok" to true,
                                            "value" to mapOf(
                                                "id" to "pl-alice-commute",
                                                "path" to "playlists/pl-alice-commute",
                                                "exists" to true,
                                                "data" to mapOf(
                                                    "title" to "Morning Commute",
                                                    "ownerUid" to "alice-uid"
                                                )
                                            )
                                        )
                                    )
                                )
                            } else {
                                transport.sendToClient(
                                    JsonCodec.encodeToString(
                                        mapOf(
                                            "type" to "worker-res",
                                            "id" to id,
                                            "ok" to false,
                                            "error" to mapOf(
                                                "code" to "permission-denied",
                                                "message" to "Missing or insufficient permissions."
                                            )
                                        )
                                    )
                                )
                            }
                        }
                        "getDocs" -> {
                            val docs = if (uid == "alice-uid" || mode == "admin") {
                                listOf(
                                    mapOf(
                                        "id" to "pl-alice-commute",
                                        "path" to "playlists/pl-alice-commute",
                                        "exists" to true,
                                        "data" to mapOf(
                                            "title" to "Morning Commute",
                                            "ownerUid" to "alice-uid"
                                        )
                                    )
                                )
                            } else {
                                emptyList()
                            }
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to "worker-res",
                                        "id" to id,
                                        "ok" to true,
                                        "value" to mapOf("docs" to docs)
                                    )
                                )
                            )
                        }
                        "updateDoc" -> {
                            if (op["path"] == "users/alice-uid/items/item-1") {
                                @Suppress("UNCHECKED_CAST")
                                val data = op["data"] as? Map<String, Any?>
                                val nextStep = (data?.get("step") as? Number)?.toLong()
                                if (nextStep != null) {
                                    itemStep.set(nextStep)
                                }
                            }
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to emptyMap<String, Any?>())
                                )
                            )
                        }
                        else -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to emptyMap<String, Any?>())
                                )
                            )
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    subRecords.add(subId to sub)
                    val target = sub["target"]
                    if (target == "authState" || target == "idToken") {
                        transport.sendToClient(
                            JsonCodec.encodeToString(mapOf("type" to "worker-snap", "subId" to subId, "value" to null))
                        )
                        return@onServerReceive
                    }
                    @Suppress("UNCHECKED_CAST")
                    val actAs = sub["actAs"] as? Map<String, Any?>
                    val mode = actAs?.get("mode") as? String
                    val uid = actAs?.get("uid") as? String
                    if (uid == "alice-uid" || mode == "admin") {
                        @Suppress("UNCHECKED_CAST")
                        val targetMap = target as? Map<String, Any?>
                        val value = if (targetMap?.get("__ref") == "doc") {
                            if (targetMap["path"] == "users/alice-uid/items/item-1") {
                                mapOf(
                                    "id" to "item-1",
                                    "path" to "users/alice-uid/items/item-1",
                                    "exists" to true,
                                    "data" to mapOf("step" to itemStep.get())
                                )
                            } else {
                                mapOf(
                                    "id" to "pl-alice-commute",
                                    "path" to "playlists/pl-alice-commute",
                                    "exists" to true,
                                    "data" to mapOf("title" to "Morning Commute", "ownerUid" to "alice-uid")
                                )
                            }
                        } else {
                            mapOf(
                                "docs" to listOf(
                                    mapOf(
                                        "id" to "pl-alice-commute",
                                        "path" to "playlists/pl-alice-commute",
                                        "exists" to true,
                                        "data" to mapOf("title" to "Morning Commute", "ownerUid" to "alice-uid")
                                    )
                                )
                            )
                        }
                        transport.sendToClient(
                            JsonCodec.encodeToString(mapOf("type" to "worker-snap", "subId" to subId, "value" to value))
                        )
                    } else {
                        transport.sendToClient(
                            JsonCodec.encodeToString(
                                mapOf(
                                    "type" to "worker-snap",
                                    "subId" to subId,
                                    "value" to mapOf(
                                        "__error" to mapOf(
                                            "code" to "permission-denied",
                                            "message" to "Missing or insufficient permissions."
                                        )
                                    )
                                )
                            )
                        )
                    }
                }
            }
        }

        bridgeClient = PyricBridgeClient(transport)
        val options = FirebaseOptions.Builder()
            .setApiKey("test-api-key")
            .setApplicationId("test-app-id")
            .setProjectId("test-project-id")
            .build()
        app = FirebaseApp.initializeApp("test-kt-isolation-app", options)
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)
    }

    @AfterEach
    fun tearDown() {
        firestore.terminate()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun storageUnauthorizedReachesRulesDenialListenerThroughBridgeEventHub() {
        val latch = CountDownLatch(1)
        val received = CopyOnWriteArrayList<FirebaseFirestoreException>()
        firestore.addRulesDenialListener { ex, _ ->
            received.add(ex)
            latch.countDown()
        }

        // Unrelated storage error must NOT fire denial observer.
        assertThrows(FirebaseFirestoreException::class.java) {
            kotlinx.coroutines.runBlocking {
                bridgeClient.op("storage.getDownloadURL", mapOf("path" to "audio/missing.wav"))
            }
        }

        // storage/unauthorized must travel end-to-end through BridgeEventHub.
        assertThrows(FirebaseFirestoreException::class.java) {
            kotlinx.coroutines.runBlocking {
                bridgeClient.op("storage.getMetadata", mapOf("path" to "audio/alice/clip.wav"))
            }
        }

        assertTrue(latch.await(3, TimeUnit.SECONDS), "Expected storage/unauthorized denial via BridgeEventHub")
        assertEquals(1, received.size)
        assertEquals("storage/unauthorized", received[0].wireCode)
    }

    @Test
    fun sourceCacheIsolatesDocumentsAndQueriesAcrossUsersAndTenants() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        val docRef = firestore.document("playlists/pl-alice-commute")
        val query = firestore.collection("playlists").whereEqualTo("ownerUid", "alice-uid")

        val aliceDoc = Tasks.await(docRef.get(Source.SERVER))
        assertEquals("Morning Commute", aliceDoc.getString("title"))
        val aliceQuery = Tasks.await(query.get(Source.SERVER))
        assertEquals(1, aliceQuery.size())

        // Alice reads own cache cleanly.
        assertEquals("Morning Commute", Tasks.await(docRef.get(Source.CACHE)).getString("title"))
        assertEquals(1, Tasks.await(query.get(Source.CACHE)).size())

        // Switch to Bob: neither doc cache nor query cache leaks Alice's private data.
        auth.setAuthLens(AuthLens.AsUser(uid = "bob-uid"))
        val bobDocErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(docRef.get(Source.CACHE))
        }
        assertEquals(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            (bobDocErr.cause as? FirebaseFirestoreException)?.code
        )
        assertEquals(0, Tasks.await(query.get(Source.CACHE)).size())

        // Switch to Anon: isolated as well.
        auth.setAuthLens(AuthLens.Anon)
        assertThrows(ExecutionException::class.java) {
            Tasks.await(docRef.get(Source.CACHE))
        }
        assertEquals(0, Tasks.await(query.get(Source.CACHE)).size())

        // Different tenant under same UID is isolated.
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid", tenant = "tenant-b"))
        assertThrows(ExecutionException::class.java) {
            Tasks.await(docRef.get(Source.CACHE))
        }
        assertEquals(0, Tasks.await(query.get(Source.CACHE)).size())

        // clearPersistence wipes QueryCacheStore as well as persistedStores.
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        Tasks.await(firestore.terminate())
        Tasks.await(firestore.clearPersistence())
        assertTrue(QueryCacheStore.get(firestore, query.toTargetDescriptor()).isNullOrEmpty())
    }

    @Test
    fun documentAndQuerySnapshotListenersRecoverAfterTransientPermissionDenied() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))

        val docInitial = CountDownLatch(1)
        val docDenied = CountDownLatch(1)
        val docRecovered = CountDownLatch(1)
        val docTitles = CopyOnWriteArrayList<String>()
        var sawDocError = false

        val docReg = firestore.document("playlists/pl-alice-commute").addSnapshotListener(
            EventListener<DocumentSnapshot> { snap, err ->
                if (err != null) {
                    if (err.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                        sawDocError = true
                        docDenied.countDown()
                    }
                    return@EventListener
                }
                val title = snap?.getString("title") ?: return@EventListener
                docTitles.add(title)
                if (!sawDocError) docInitial.countDown() else docRecovered.countDown()
            }
        )

        val queryInitial = CountDownLatch(1)
        val queryDenied = CountDownLatch(1)
        val queryRecovered = CountDownLatch(1)
        var sawQueryError = false
        val querySizes = CopyOnWriteArrayList<Int>()

        val queryReg = firestore.collection("playlists").addSnapshotListener(
            EventListener<QuerySnapshot> { snap, err ->
                if (err != null) {
                    if (err.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                        sawQueryError = true
                        queryDenied.countDown()
                    }
                    return@EventListener
                }
                if (snap != null) {
                    querySizes.add(snap.size())
                    if (!sawQueryError) queryInitial.countDown() else queryRecovered.countDown()
                }
            }
        )

        try {
            assertTrue(docInitial.await(3, TimeUnit.SECONDS))
            assertTrue(queryInitial.await(3, TimeUnit.SECONDS))

            // Switch to Anon -> transient PERMISSION_DENIED on both listeners.
            auth.setAuthLens(AuthLens.Anon)
            assertTrue(docDenied.await(3, TimeUnit.SECONDS))
            assertTrue(queryDenied.await(3, TimeUnit.SECONDS))

            // Switch to Admin -> both listeners resubscribe and recover automatically.
            auth.setAuthLens(AuthLens.Admin)
            assertTrue(docRecovered.await(3, TimeUnit.SECONDS), "Document listener should recover on lens switch")
            assertTrue(queryRecovered.await(3, TimeUnit.SECONDS), "Query listener should recover on lens switch")
            assertEquals(listOf("Morning Commute", "Morning Commute"), docTitles)
            assertEquals(listOf(1, 1), querySizes)
        } finally {
            docReg.remove()
            queryReg.remove()
        }
    }

    @Test
    fun excludeMetadataDocumentListenerSuppressesReconnectDuplicateAndRecoversAfterDenial() {
        auth.setAuthLens(AuthLens.AsUser(uid = "alice-uid"))
        val docRef = firestore.document("users/alice-uid/items/item-1")

        val initialReady = CountDownLatch(1)
        val offlineWriteReady = CountDownLatch(1)
        val deniedReady = CountDownLatch(1)
        val recoveredReady = CountDownLatch(1)
        val delivered = CopyOnWriteArrayList<Pair<Long?, SnapshotMetadata>>()
        var sawDenial = false

        val reg = docRef.addSnapshotListener(MetadataChanges.EXCLUDE) { snap, err ->
            if (err != null) {
                if (err.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                    sawDenial = true
                    deniedReady.countDown()
                }
                return@addSnapshotListener
            }
            if (snap != null) {
                delivered.add(snap.getLong("step") to snap.metadata)
                when {
                    delivered.size == 1 -> initialReady.countDown()
                    snap.getLong("step") == 2L && snap.metadata.hasPendingWrites -> offlineWriteReady.countDown()
                    sawDenial -> recoveredReady.countDown()
                }
            }
        }

        try {
            assertTrue(initialReady.await(3, TimeUnit.SECONDS))
            assertEquals(1, delivered.size)
            assertEquals(1L to SnapshotMetadata(hasPendingWrites = false, isFromCache = false), delivered[0])

            Tasks.await(firestore.disableNetwork())
            val writeTask = docRef.update("step", 2L)
            assertTrue(offlineWriteReady.await(3, TimeUnit.SECONDS))
            assertEquals(2, delivered.size)
            assertEquals(2L to SnapshotMetadata(hasPendingWrites = true, isFromCache = true), delivered[1])

            val inSyncReady = CountDownLatch(1)
            val inSyncReg = firestore.addSnapshotsInSyncListener { inSyncReady.countDown() }
            try {
                Tasks.await(firestore.enableNetwork())
                Tasks.await(writeTask)
                assertTrue(inSyncReady.await(3, TimeUnit.SECONDS))
            } finally {
                inSyncReg.remove()
            }
            assertEquals(2, delivered.size, "MetadataChanges.EXCLUDE must suppress metadata-only server ack on reconnect")

            auth.setAuthLens(AuthLens.Anon)
            assertTrue(deniedReady.await(3, TimeUnit.SECONDS))

            auth.setAuthLens(AuthLens.Admin)
            assertTrue(recoveredReady.await(3, TimeUnit.SECONDS))
            assertEquals(3, delivered.size)
            assertEquals(2L to SnapshotMetadata(hasPendingWrites = false, isFromCache = false), delivered[2])
        } finally {
            reg.remove()
        }
    }
}
