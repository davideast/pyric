package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.EventListener
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.QuerySnapshot
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ChallengerAuthStateAndSnapshotTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val sentSubs = CopyOnWriteArrayList<Map<String, Any?>>()
    private val sentUnsubs = CopyOnWriteArrayList<String>()
    private var authStateSubId: String? = null
    private var idTokenSubId: String? = null

    @BeforeEach
    fun setUp() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        sentOps.clear()
        sentSubs.clear()
        sentUnsubs.clear()
        authStateSubId = null
        idTokenSubId = null

        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            val type = msg["type"] as? String

            when (type) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    sentSubs.add(sub)
                    val target = sub["target"]
                    val targetMap = target as? Map<*, *>
                    val targetName = targetMap?.get("target") as? String

                    if (targetName == "authState" || target == "authState") {
                        authStateSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    } else if (targetName == "idToken" || target == "idToken") {
                        idTokenSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    } else if (targetMap != null) {
                        @Suppress("UNCHECKED_CAST")
                        val refType = targetMap["__ref"] as? String
                        val actAs = sub["actAs"] as? Map<*, *>
                        val mode = actAs?.get("mode") as? String

                        if (refType == "doc") {
                            val path = targetMap["path"] as String
                            val docId = path.substringAfterLast('/')
                            val docValue = if (mode == "as") {
                                """{"id":"$docId","path":"$path","exists":true,"data":{"json":"{\"secret\":\"authenticated-data\"}"}}"""
                            } else {
                                """{"id":"$docId","path":"$path","exists":true,"data":{"json":"{\"public\":\"anon-data\"}"}}"""
                            }
                            transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":$docValue}""")
                        } else if (refType == "collection" || refType == "query") {
                            val collPath = (targetMap["path"] as? String) ?: "items"
                            val queryValue = if (mode == "as") {
                                """{"docs":[{"id":"doc1","path":"$collPath/doc1","exists":true,"data":{"json":"{\"val\":\"secret\"}"}}]}"""
                            } else {
                                """{"docs":[{"id":"doc1","path":"$collPath/doc1","exists":true,"data":{"json":"{\"val\":\"public\"}"}}]}"""
                            }
                            transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":$queryValue}""")
                        }
                    }
                }
                "worker-unsub" -> {
                    val subId = msg["subId"] as String
                    sentUnsubs.add(subId)
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    val method = op["method"] as String

                    when (method) {
                        "auth.signInEmail" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-alice","email":"alice@example.com","displayName":"Alice","isAnonymous":false},"operationType":"signIn"}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        else -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
            }
        }

        app = FirebaseApp.initializeApp(
            "ChallengerApp-${System.currentTimeMillis()}",
            FirebaseOptions.Builder()
                .setApiKey("test-key")
                .setApplicationId("test-app")
                .setProjectId("test-proj")
                .build()
        )
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)
    }

    @AfterEach
    fun tearDown() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
    }

    @Test
    fun testAuthStateAndIdTokenStreamLifecycleOrdering() = runBlocking {
        val observedAuthEvents = CopyOnWriteArrayList<String?>()
        val observedIdTokenEvents = CopyOnWriteArrayList<String?>()

        val jobScope = CoroutineScope(Dispatchers.IO)

        val authJob = jobScope.launch {
            auth.authStateFlow().collect { user ->
                observedAuthEvents.add(user?.uid)
            }
        }

        val idTokenJob = jobScope.launch {
            auth.idTokenFlow().collect { user ->
                observedIdTokenEvents.add(user?.uid)
            }
        }

        // 1. Initial unauthenticated state: both must emit null
        var waitCount = 0
        while ((observedAuthEvents.isEmpty() || observedIdTokenEvents.isEmpty()) && waitCount++ < 50) {
            Thread.sleep(10)
        }
        assertEquals(listOf<String?>(null), observedAuthEvents.toList(), "Initial authStateFlow must be null")
        assertEquals(listOf<String?>(null), observedIdTokenEvents.toList(), "Initial idTokenFlow must be null")

        // 2. Sign in as Alice -> both emit user-alice
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        waitCount = 0
        while ((observedAuthEvents.size < 2 || observedIdTokenEvents.size < 2) && waitCount++ < 50) {
            Thread.sleep(10)
        }
        assertEquals(listOf(null, "user-alice"), observedAuthEvents.toList())
        assertEquals(listOf(null, "user-alice"), observedIdTokenEvents.toList())

        // 3. Token change occurs while signed in -> idTokenFlow emits new event, authStateFlow remains stable
        assertNotNull(idTokenSubId, "Bridge should have received idToken subscription")
        transport.sendToClient("""{"type":"worker-snap","subId":"$idTokenSubId","value":{"token":"new-refreshed-jwt"}}""")
        waitCount = 0
        while (observedIdTokenEvents.size < 3 && waitCount++ < 50) {
            Thread.sleep(10)
        }
        assertEquals(listOf(null, "user-alice"), observedAuthEvents.toList(), "authStateFlow should NOT emit duplicate on token change")
        assertEquals(listOf(null, "user-alice", "user-alice"), observedIdTokenEvents.toList(), "idTokenFlow MUST emit on token refresh")

        // 4. Sign out -> both emit null
        auth.signOut()
        waitCount = 0
        while ((observedAuthEvents.size < 3 || observedIdTokenEvents.size < 4) && waitCount++ < 50) {
            Thread.sleep(10)
        }
        assertEquals(listOf(null, "user-alice", null), observedAuthEvents.toList(), "authStateFlow lifecycle order: null -> user -> null")
        assertEquals(listOf(null, "user-alice", "user-alice", null), observedIdTokenEvents.toList(), "idTokenFlow lifecycle order: null -> user -> token -> null")

        authJob.cancel()
        idTokenJob.cancel()
        jobScope.cancel()
    }

    @Test
    fun testDocumentAndQuerySnapshotsReevaluateAcrossAuthTransitions() {
        val docRef = firestore.document("users/alice")
        val collRef = firestore.collection("items")

        val docSnapshots = CopyOnWriteArrayList<DocumentSnapshot>()
        val querySnapshots = CopyOnWriteArrayList<QuerySnapshot>()

        val docLatch1 = CountDownLatch(1)
        val queryLatch1 = CountDownLatch(1)

        val docReg = docRef.addSnapshotListener(EventListener { snap, _ ->
            if (snap != null) {
                docSnapshots.add(snap)
                docLatch1.countDown()
            }
        })

        val queryReg = collRef.addSnapshotListener(EventListener { snap, _ ->
            if (snap != null) {
                querySnapshots.add(snap)
                queryLatch1.countDown()
            }
        })

        // Step 1: Verify initial unauthenticated snapshots
        assertTrue(docLatch1.await(2, TimeUnit.SECONDS), "Initial doc snapshot timeout")
        assertTrue(queryLatch1.await(2, TimeUnit.SECONDS), "Initial query snapshot timeout")
        assertEquals("anon-data", docSnapshots.first().getString("public"))
        assertEquals("public", querySnapshots.first().documents.first().getString("val"))

        // Step 2: Sign in as Alice -> snapshot streams re-subscribe with mode: 'as'
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))

        var authenticatedDocSubFound = false
        var authenticatedQuerySubFound = false
        for (i in 0 until 50) {
            val docSubs = sentSubs.filter {
                val t = it["target"] as? Map<*, *>
                t?.get("__ref") == "doc" && (it["actAs"] as? Map<*, *>)?.get("mode") == "as"
            }
            val querySubs = sentSubs.filter {
                val t = it["target"] as? Map<*, *>
                (t?.get("__ref") == "query" || t?.get("__ref") == "collection") && (it["actAs"] as? Map<*, *>)?.get("mode") == "as"
            }
            if (docSubs.isNotEmpty()) authenticatedDocSubFound = true
            if (querySubs.isNotEmpty()) authenticatedQuerySubFound = true
            if (authenticatedDocSubFound && authenticatedQuerySubFound) break
            Thread.sleep(10)
        }
        assertTrue(authenticatedDocSubFound, "Document snapshot should re-subscribe with mode: as")
        assertTrue(authenticatedQuerySubFound, "Query snapshot should re-subscribe with mode: as")

        // Check that new snapshots with authenticated data were received
        for (i in 0 until 50) {
            if (docSnapshots.any { it.getString("secret") == "authenticated-data" } &&
                querySnapshots.any { it.documents.any { d -> d.getString("val") == "secret" } }) {
                break
            }
            Thread.sleep(10)
        }
        assertTrue(docSnapshots.any { it.getString("secret") == "authenticated-data" }, "Should receive authenticated doc snapshot")
        assertTrue(querySnapshots.any { it.documents.any { d -> d.getString("val") == "secret" } }, "Should receive authenticated query snapshot")

        // Step 3: Sign out -> snapshot streams re-subscribe with mode: 'anon'
        auth.signOut()

        var anonDocSubFoundAfterSignOut = false
        var anonQuerySubFoundAfterSignOut = false
        for (i in 0 until 50) {
            // Count total anon subs; should be >= 2 for each
            val docAnonSubs = sentSubs.filter {
                val t = it["target"] as? Map<*, *>
                t?.get("__ref") == "doc" && (it["actAs"] as? Map<*, *>)?.get("mode") == "anon"
            }
            val queryAnonSubs = sentSubs.filter {
                val t = it["target"] as? Map<*, *>
                (t?.get("__ref") == "query" || t?.get("__ref") == "collection") && (it["actAs"] as? Map<*, *>)?.get("mode") == "anon"
            }
            if (docAnonSubs.size >= 2) anonDocSubFoundAfterSignOut = true
            if (queryAnonSubs.size >= 2) anonQuerySubFoundAfterSignOut = true
            if (anonDocSubFoundAfterSignOut && anonQuerySubFoundAfterSignOut) break
            Thread.sleep(10)
        }
        assertTrue(anonDocSubFoundAfterSignOut, "Document snapshot should re-subscribe with mode: anon after sign-out")
        assertTrue(anonQuerySubFoundAfterSignOut, "Query snapshot should re-subscribe with mode: anon after sign-out")

        docReg.remove()
        queryReg.remove()
    }
}
