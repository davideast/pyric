package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@DisplayName("Milestone 2 Challenger: Kotlin Boundary Stress Tests")
class ChallengerBoundaryStressTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val sentSubs = CopyOnWriteArrayList<Map<String, Any?>>()
    private val sentUnsubs = CopyOnWriteArrayList<String>()

    @BeforeEach
    fun setUp() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        sentOps.clear()
        sentSubs.clear()
        sentUnsubs.clear()

        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { messageJson ->
            val msg = JsonCodec.decodeMap(messageJson)
            val type = msg["type"] as? String

            when (type) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"sess-stress-kt"}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    val enrichedSub = HashMap(sub)
                    enrichedSub["subId"] = subId
                    sentSubs.add(enrichedSub)
                    val target = sub["target"]
                    val targetMap = target as? Map<*, *>
                    val targetName = targetMap?.get("target") as? String

                    if (targetName == "authState" || target == "authState") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    } else if (targetName == "idToken" || target == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
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
                        "auth.signInAnonymously" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"anon-kt-user","isAnonymous":true},"operationType":"signIn"}}"""
                            )
                        }
                        "auth.signInEmail" -> {
                            val email = op["email"] as? String ?: "user@test.com"
                            val uid = "uid-${email.replace("@test.com", "")}"
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"$uid","email":"$email","isAnonymous":false},"operationType":"signIn"}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        else -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"doc1","exists":true,"data":{"json":"{}"}}}"""
                            )
                        }
                    }
                }
            }
        }

        app = FirebaseApp.initializeApp(
            "BoundaryStressApp-${System.currentTimeMillis()}",
            FirebaseOptions.Builder()
                .setApiKey("stress-key")
                .setApplicationId("stress-app-id")
                .setProjectId("stress-proj")
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
    fun `Rapid sequential auth switching maintains exact lens state across 50 cycles`() = runBlocking {
        for (i in 0 until 25) {
            // Anon sign in
            val anonTask = auth.signInAnonymously()
            val anonRes = Tasks.await(anonTask, 5, TimeUnit.SECONDS)
            assertNotNull(anonRes)
            assertEquals("anon-kt-user", anonRes!!.user!!.uid)
            val anonLens = firestore.getEffectiveAuthLens()
            assertTrue(anonLens is AuthLens.AsUser)
            assertEquals("anon-kt-user", (anonLens as AuthLens.AsUser).uid)

            // Switch to email user
            val emailTask = auth.signInWithEmailAndPassword("user$i@test.com", "pass$i")
            val emailRes = Tasks.await(emailTask, 5, TimeUnit.SECONDS)
            assertNotNull(emailRes)
            assertEquals("uid-user$i", emailRes!!.user!!.uid)
            val userLens = firestore.getEffectiveAuthLens()
            assertTrue(userLens is AuthLens.AsUser)
            assertEquals("uid-user$i", (userLens as AuthLens.AsUser).uid)

            // Sign out
            auth.signOut()
            delay(10)
            val signedOutLens = firestore.getEffectiveAuthLens()
            assertTrue(signedOutLens is AuthLens.Anon)
        }

        assertEquals(AuthLens.Anon, firestore.getEffectiveAuthLens())
    }

    @Test
    fun `Concurrent operations during rapid auth transitions never observe corrupt actAs`() = runBlocking {
        val keepRunning = AtomicBoolean(true)

        // Launch background auth churn
        val authJob = launch(Dispatchers.IO) {
            var cycle = 0
            while (keepRunning.get()) {
                cycle++
                when (cycle % 3) {
                    0 -> auth.signOut()
                    1 -> Tasks.await(auth.signInAnonymously(), 5, TimeUnit.SECONDS)
                    2 -> Tasks.await(auth.signInWithEmailAndPassword("concurrent$cycle@test.com", "pass"), 5, TimeUnit.SECONDS)
                }
                delay(2)
            }
        }

        // Launch 60 concurrent document operations
        val opsJobs = (0 until 60).map { i ->
            launch(Dispatchers.IO) {
                val doc = firestore.document("concurrent_test/doc_$i")
                when (i % 3) {
                    0 -> Tasks.await(doc.get(), 5, TimeUnit.SECONDS)
                    1 -> Tasks.await(doc.set(mapOf("test" to i)), 5, TimeUnit.SECONDS)
                    2 -> Tasks.await(doc.delete(), 5, TimeUnit.SECONDS)
                }
            }
        }

        opsJobs.forEach { it.join() }
        keepRunning.set(false)
        authJob.join()

        // Verify captured document operations
        val docOps = sentOps.filter { op ->
            val method = op["method"] as? String ?: ""
            method in listOf("getDoc", "setDoc", "deleteDoc")
        }

        assertTrue(docOps.size >= 60, "Expected at least 60 document operations")
        for (op in docOps) {
            @Suppress("UNCHECKED_CAST")
            val actAs = op["actAs"] as? Map<String, Any?>
            assertNotNull(actAs, "actAs must not be null on op ${op["method"]}")
            val mode = actAs!!["mode"] as? String
            assertTrue(mode in listOf("anon", "as", "admin"), "actAs mode must be valid: $mode")
            if (mode == "as") {
                val uid = actAs["uid"] as? String
                assertNotNull(uid, "uid must not be null when mode is 'as'")
                assertTrue(uid!!.isNotEmpty(), "uid must not be empty")
            }
        }
    }

    @Test
    fun `Dynamic snapshot re-subscriptions cancel prior subscriptions and leave zero leaks`() = runBlocking {
        val doc = firestore.document("leak_test/doc_kt")
        val latch = CountDownLatch(1)
        val registration = doc.addSnapshotListener { snapshot, error ->
            latch.countDown()
        }

        // Send initial snapshot to listener
        delay(50)
        val initialDocSub = sentSubs.find { sub ->
            @Suppress("UNCHECKED_CAST")
            val target = sub["target"] as? Map<String, Any?> ?: emptyMap()
            target["path"] == "leak_test/doc_kt"
        }
        assertNotNull(initialDocSub)
        val initialSubId = initialDocSub!!["subId"] as String

        transport.sendToClient(
            """{"type":"worker-snap","subId":"$initialSubId","value":{"id":"doc_kt","exists":true,"data":{"json":"{}"}}}"""
        )
        assertTrue(latch.await(3, TimeUnit.SECONDS))

        // Trigger 5 auth switches
        for (i in 0 until 5) {
            Tasks.await(auth.signInWithEmailAndPassword("churn$i@test.com", "pass"), 5, TimeUnit.SECONDS)
            delay(50)
        }

        // Cancel snapshot listener registration
        registration.remove()
        delay(100)

        val docSubFrames = sentSubs.filter { sub ->
            @Suppress("UNCHECKED_CAST")
            val target = sub["target"] as? Map<String, Any?> ?: emptyMap()
            target["path"] == "leak_test/doc_kt"
        }
        val docSubIds = docSubFrames.map { it["subId"] as String }.toSet()
        val unsubs = sentUnsubs.toSet()

        val leaked = docSubIds - unsubs
        assertTrue(leaked.isEmpty(), "Leaked doc subscriptions without worker-unsub: $leaked")
    }
}
