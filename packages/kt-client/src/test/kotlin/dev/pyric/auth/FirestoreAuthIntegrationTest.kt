package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.EventListener
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class FirestoreAuthIntegrationTest {

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
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    val method = op["method"] as String

                    when (method) {
                        "auth.signInEmail" -> {
                            val email = op["email"] as? String
                            val userMap = if (email == "admin@example.com") {
                                mapOf(
                                    "uid" to "user-admin",
                                    "email" to "admin@example.com",
                                    "displayName" to "Admin",
                                    "isAnonymous" to false,
                                    "customClaims" to mapOf("role" to "admin", "tier" to "gold")
                                )
                            } else {
                                mapOf(
                                    "uid" to "user-alice",
                                    "email" to "alice@example.com",
                                    "displayName" to "Alice",
                                    "isAnonymous" to false
                                )
                            }
                            val userJson = JsonCodec.encodeToString(userMap)
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":$userJson,"operationType":"signIn"}}"""
                            )
                            authStateSubId?.let { sId ->
                                transport.sendToClient(
                                    """{"type":"worker-snap","subId":"$sId","value":$userJson}"""
                                )
                            }
                        }
                        "auth.getIdTokenResult" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"mock-token","claims":{"role":"admin","sub":"user-alice"}}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                            authStateSubId?.let { sId ->
                                transport.sendToClient("""{"type":"worker-snap","subId":"$sId","value":null}""")
                            }
                        }
                        "getDoc" -> {
                            val path = op["path"] as String
                            val idPart = path.substringAfterLast('/')
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"$idPart","path":"$path","exists":true,"data":{"json":"{\"title\":\"Test\"}"}}}"""
                            )
                        }
                        "getDocs" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"docs":[{"id":"doc1","path":"items/doc1","exists":true,"data":{"json":"{\"name\":\"item1\"}"}}]}}"""
                            )
                        }
                        "count" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":{"count":5}}""")
                        }
                        "aggregate" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"data":{"avg_score":88.5}}}"""
                            )
                        }
                        else -> {
                            // setDoc, updateDoc, deleteDoc, batchCommit, txnCommit
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    sentSubs.add(sub)

                    @Suppress("UNCHECKED_CAST")
                    val target = sub["target"] as? Map<String, Any?>
                    val targetName = target?.get("target") as? String
                    if (targetName == "authState") {
                        authStateSubId = subId
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                        return@onServerReceive
                    }
                    if (targetName == "idToken") {
                        idTokenSubId = subId
                        return@onServerReceive
                    }

                    @Suppress("UNCHECKED_CAST")
                    val actAs = sub["actAs"] as? Map<String, Any?>
                    val mode = actAs?.get("mode") as? String

                    // If anon and we want to simulate rules denial on sign-out
                    if (mode == "anon" && sentUnsubs.isNotEmpty()) {
                        // Denied for unauthenticated
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"__error":{"code":"permission-denied","message":"Missing or insufficient permissions"}}}"""
                        )
                    } else {
                        transport.sendToClient(
                            """{"type":"worker-snap","subId":"$subId","value":{"id":"alice","path":"users/alice","exists":true,"data":{"json":"{\"role\":\"member\"}"}}}"""
                        )
                    }
                }
                "worker-unsub" -> {
                    val subId = msg["subId"] as String
                    sentUnsubs.add(subId)
                }
            }
        }

        app = FirebaseApp.initializeApp(
            "integration-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-integration")
                .setApiKey("fake-key")
                .setApplicationId("fake-app")
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
    fun testDocCrudStampsActAsAnonWhenSignedOut() {
        val docRef = firestore.document("users/guest")

        // 1. getDoc
        val snap = Tasks.await(docRef.get())
        assertTrue(snap.exists())
        val getOp = sentOps.find { it["method"] == "getDoc" }
        assertNotNull(getOp)
        assertEquals(mapOf("mode" to "anon"), getOp?.get("actAs"))

        // 2. setDoc
        Tasks.await(docRef.set(mapOf("test" to "data")))
        val setOp = sentOps.find { it["method"] == "setDoc" }
        assertNotNull(setOp)
        assertEquals(mapOf("mode" to "anon"), setOp?.get("actAs"))

        // 3. updateDoc
        Tasks.await(docRef.update(mapOf("test" to "updated")))
        val updateOp = sentOps.find { it["method"] == "updateDoc" }
        assertNotNull(updateOp)
        assertEquals(mapOf("mode" to "anon"), updateOp?.get("actAs"))

        // 4. deleteDoc
        Tasks.await(docRef.delete())
        val deleteOp = sentOps.find { it["method"] == "deleteDoc" }
        assertNotNull(deleteOp)
        assertEquals(mapOf("mode" to "anon"), deleteOp?.get("actAs"))
    }

    @Test
    fun testDocCrudStampsActAsUserWhenSignedIn() {
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        val docRef = firestore.document("users/alice")

        // 1. getDoc
        val snap = Tasks.await(docRef.get())
        assertTrue(snap.exists())
        val getOp = sentOps.find { it["method"] == "getDoc" }
        assertNotNull(getOp)
        @Suppress("UNCHECKED_CAST")
        val actAsGet = getOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsGet["mode"])
        assertEquals("user-alice", actAsGet["uid"])

        // 2. setDoc
        Tasks.await(docRef.set(mapOf("name" to "Alice")))
        val setOp = sentOps.find { it["method"] == "setDoc" }
        assertNotNull(setOp)
        @Suppress("UNCHECKED_CAST")
        val actAsSet = setOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsSet["mode"])
        assertEquals("user-alice", actAsSet["uid"])

        // 3. updateDoc
        Tasks.await(docRef.update(mapOf("name" to "Alice A")))
        val updateOp = sentOps.find { it["method"] == "updateDoc" }
        assertNotNull(updateOp)
        @Suppress("UNCHECKED_CAST")
        val actAsUpdate = updateOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsUpdate["mode"])
        assertEquals("user-alice", actAsUpdate["uid"])

        // 4. deleteDoc
        Tasks.await(docRef.delete())
        val deleteOp = sentOps.find { it["method"] == "deleteDoc" }
        assertNotNull(deleteOp)
        @Suppress("UNCHECKED_CAST")
        val actAsDelete = deleteOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsDelete["mode"])
        assertEquals("user-alice", actAsDelete["uid"])
    }

    @Test
    fun testQueriesAndAggregationsStampActAs() {
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        val coll = firestore.collection("items")

        // Query
        val querySnap = Tasks.await(coll.whereEqualTo("active", true).get())
        assertEquals(1, querySnap.size())
        val queryOp = sentOps.find { it["method"] == "getDocs" }
        assertNotNull(queryOp)
        @Suppress("UNCHECKED_CAST")
        val actAsQuery = queryOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsQuery["mode"])
        assertEquals("user-alice", actAsQuery["uid"])

        // Count
        val countSnap = Tasks.await(coll.count().get())
        assertEquals(5L, countSnap.count)
        val countOp = sentOps.find { it["method"] == "count" }
        assertNotNull(countOp)
        @Suppress("UNCHECKED_CAST")
        val actAsCount = countOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsCount["mode"])
        assertEquals("user-alice", actAsCount["uid"])

        // Aggregate
        val aggSnap = Tasks.await(coll.aggregate(AggregateField.average("score")).get())
        assertEquals(88.5, aggSnap.get(AggregateField.average("score")))
        val aggOp = sentOps.find { it["method"] == "aggregate" }
        assertNotNull(aggOp)
        @Suppress("UNCHECKED_CAST")
        val actAsAgg = aggOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsAgg["mode"])
        assertEquals("user-alice", actAsAgg["uid"])
    }

    @Test
    fun testBatchAndTxnStampActAs() {
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))

        // Batch
        val batch = firestore.batch()
        batch.set(firestore.document("users/1"), mapOf("a" to 1))
        Tasks.await(batch.commit())

        val batchOp = sentOps.find { it["method"] == "batchCommit" }
        assertNotNull(batchOp)
        @Suppress("UNCHECKED_CAST")
        val actAsBatch = batchOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsBatch["mode"])
        assertEquals("user-alice", actAsBatch["uid"])

        // Transaction
        val txnResult = Tasks.await(firestore.runTransaction { txn ->
            txn.set(firestore.document("users/2"), mapOf("b" to 2))
            "committed"
        })
        assertEquals("committed", txnResult)

        val txnOp = sentOps.find { it["method"] == "txnCommit" }
        assertNotNull(txnOp)
        @Suppress("UNCHECKED_CAST")
        val actAsTxn = txnOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAsTxn["mode"])
        assertEquals("user-alice", actAsTxn["uid"])
    }

    @Test
    fun testSnapshotStreamResubscriptionOnSignIn() {
        val docRef = firestore.document("users/alice")

        // 1. Initial anonymous subscription kept active via snapshot listener
        val initialLatch = CountDownLatch(1)
        var initialSnap: DocumentSnapshot? = null
        val reg = docRef.addSnapshotListener(EventListener { snapshot, error ->
            if (snapshot != null) {
                initialSnap = snapshot
                initialLatch.countDown()
            }
        })

        assertTrue(initialLatch.await(2, TimeUnit.SECONDS))
        assertNotNull(initialSnap)
        assertTrue(initialSnap!!.exists())

        val docSubs = sentSubs.filter {
            @Suppress("UNCHECKED_CAST")
            (it["target"] as? Map<String, Any?>)?.get("__ref") == "doc"
        }
        assertTrue(docSubs.isNotEmpty())
        @Suppress("UNCHECKED_CAST")
        val firstSubActAs = docSubs[0]["actAs"] as Map<String, Any?>
        assertEquals("anon", firstSubActAs["mode"])

        // 2. Sign in as Alice
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))

        // Verify unsubscription for anonymous listener and re-subscription for user
        var authenticatedSub: Map<String, Any?>? = null
        for (i in 0 until 50) {
            authenticatedSub = sentSubs.find {
                @Suppress("UNCHECKED_CAST")
                (it["actAs"] as? Map<String, Any?>)?.get("mode") == "as"
            }
            if (authenticatedSub != null) break
            Thread.sleep(10)
        }
        assertNotNull(authenticatedSub)
        @Suppress("UNCHECKED_CAST")
        val actAsAuth = authenticatedSub?.get("actAs") as Map<String, Any?>
        assertEquals("user-alice", actAsAuth["uid"])

        reg.remove()
    }

    @Test
    fun testSnapshotStreamPermissionDeniedOnSignOut() {
        // Start signed in
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        val docRef = firestore.document("users/alice")

        val errorLatch = CountDownLatch(1)
        var receivedError: FirebaseFirestoreException? = null

        val reg = docRef.addSnapshotListener(EventListener { snapshot, error ->
            if (error != null) {
                receivedError = error
                errorLatch.countDown()
            }
        })

        Thread.sleep(50)
        // Sign out triggers re-sub as anon, which mock bridge returns permission-denied for
        auth.signOut()

        val completed = errorLatch.await(2, TimeUnit.SECONDS)
        assertTrue(completed, "Expected permission-denied error callback on sign out")
        assertNotNull(receivedError)
        assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, receivedError?.code)

        reg.remove()
    }

    @Test
    fun testDocOperationsStampCustomClaims() {
        Tasks.await(auth.signInWithEmailAndPassword("admin@example.com", "secret"))
        val docRef = firestore.document("settings/admin")

        Tasks.await(docRef.set(mapOf("theme" to "dark")))
        val setOp = sentOps.find { it["method"] == "setDoc" }
        assertNotNull(setOp)
        @Suppress("UNCHECKED_CAST")
        val actAs = setOp?.get("actAs") as Map<String, Any?>
        assertEquals("as", actAs["mode"])
        assertEquals("user-admin", actAs["uid"])
        @Suppress("UNCHECKED_CAST")
        val token = actAs["token"] as Map<String, Any?>
        assertEquals("user-admin", token["sub"])
        assertEquals("user-admin", token["user_id"])
        assertEquals("admin", token["role"])
        assertEquals("gold", token["tier"])
    }

    @Test
    fun testSnapshotStreamResubscriptionOnIdTokenClaimRefresh() {
        // 1. Sign in as Alice with no custom claims
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        val docRef = firestore.document("users/alice")

        val latch = CountDownLatch(1)
        val reg = docRef.addSnapshotListener(EventListener { snapshot, _ ->
            if (snapshot != null) {
                latch.countDown()
            }
        })
        assertTrue(latch.await(2, TimeUnit.SECONDS))

        // Find initial subscription for Alice without custom claims
        val initialSub = sentSubs.find {
            @Suppress("UNCHECKED_CAST")
            val actAs = it["actAs"] as? Map<String, Any?>
            val token = actAs?.get("token") as? Map<*, *>
            actAs?.get("mode") == "as" && token?.get("role") == null
        }
        assertNotNull(initialSub, "Expected initial subscription without custom claims")

        // 2. Refresh token / claims
        Tasks.await(auth.currentUser!!.getIdToken(forceRefresh = true))

        // 3. Verify snapshot listener re-subscribed with updated custom claims
        var claimSub: Map<String, Any?>? = null
        for (i in 0 until 50) {
            claimSub = sentSubs.find {
                @Suppress("UNCHECKED_CAST")
                val actAs = it["actAs"] as? Map<String, Any?>
                val token = actAs?.get("token") as? Map<*, *>
                actAs?.get("mode") == "as" && token?.get("role") == "admin"
            }
            if (claimSub != null) break
            Thread.sleep(10)
        }
        assertNotNull(claimSub, "Expected re-subscription with custom claims token")
        @Suppress("UNCHECKED_CAST")
        val actAsClaims = claimSub?.get("actAs") as Map<String, Any?>
        assertEquals("user-alice", actAsClaims["uid"])
        @Suppress("UNCHECKED_CAST")
        val tokenClaims = actAsClaims["token"] as Map<String, Any?>
        assertEquals("admin", tokenClaims["role"])
        assertEquals("user-alice", tokenClaims["sub"])

        reg.remove()
    }
}
