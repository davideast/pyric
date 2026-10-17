package dev.pyric.bridge

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.database.FirebaseDatabase
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Every operation entry point sends or holds its frame on the caller's thread
 * before it returns (delivery contract D2), so operations issued in program
 * order reach the host in that order across Auth, Firestore and the Realtime
 * Database (D1). The oracle is the thread that handed each frame to the
 * transport: a send moved onto another thread fails the test however the
 * scheduler runs.
 */
class CallOrderTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var client: PyricBridgeClient
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var database: FirebaseDatabase

    /** One operation frame as the transport took it. */
    private data class Sent(val method: String, val thread: Thread)

    private val sent = CopyOnWriteArrayList<Sent>()
    @Volatile private var awaitedCount = Int.MAX_VALUE
    private val allSent = CompletableDeferred<Unit>()

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        val app = FirebaseApp.initializeApp(
            "call-order-app",
            FirebaseOptions.Builder()
                .setProjectId("order-project")
                .setApiKey("order-key")
                .setApplicationId("order-app-id")
                .build()
        )
        bridge.onFrame = { frame -> record(frame) }
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        auth = FirebaseAuth(app, client)
        firestore = FirebaseFirestore(client, app, "(default)", credentialsProvider = auth)
        database = FirebaseDatabase(client, app, "https://order-project-default-rtdb.firebaseio.com", auth)
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Suppress("UNCHECKED_CAST")
    private fun record(frame: Map<String, Any?>) {
        if (frame["type"] != "worker-op") return
        val method = (frame["op"] as Map<String, Any?>)["method"] as String
        sent.add(Sent(method, Thread.currentThread()))
        if (sent.size >= awaitedCount) allSent.complete(Unit)
    }

    private suspend fun awaitState(state: BridgeConnectionState) {
        withTimeout(10_000) { client.connectionStates.first { it == state } }
    }

    private fun user(): FirebaseUser = FirebaseUser(auth, mapOf("uid" to "u1"))

    /** Every public entry point that sends an operation, other than the writes #1028 and #1036 cover. */
    private fun entryPoints(): List<Pair<String, () -> Unit>> {
        val doc = firestore.document("rooms/a")
        val rooms = firestore.collection("rooms")
        val ref = database.getReference("rooms/a")
        return listOf(
            "auth.signInEmail" to { auth.signInWithEmailAndPassword("a@b.c", "pw") },
            "auth.createUser" to { auth.createUserWithEmailAndPassword("a@b.c", "pw") },
            "auth.signInAnonymously" to { auth.signInAnonymously() },
            "auth.signInWithCredential" to { auth.signInWithCredential(mapOf("providerId" to "google.com")) },
            "auth.signInWithCredential" to { auth.signInWithCredential(GoogleAuthProvider.getCredential("id", null)) },
            "auth.signOut" to { auth.signOut() },
            "auth.getIdTokenResult" to { user().getIdToken(false) },
            "auth.getIdTokenResult" to { user().getIdTokenResult(true) },
            "auth.updateProfile" to { user().updateProfile(UserProfileChangeRequest.Builder().setDisplayName("n").build()) },
            "auth.getCurrentUser" to { user().reload() },
            "getDoc" to { doc.get() },
            "getDocs" to { rooms.get() },
            "getDocs" to { rooms.whereEqualTo("open", true).limit(2).get() },
            "count" to { rooms.count().get() },
            "aggregate" to { rooms.aggregate(AggregateField.sum("n")).get() },
            "rtdb.get" to { ref.get() },
            "rtdb.get" to { database.getReference("rooms").orderByChild("n").limitToFirst(2).get() }
        )
    }

    @Test
    fun `every operation entry point sends its frame on the caller's thread before it returns`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)
        val caller = Thread.currentThread()

        for ((method, call) in entryPoints()) {
            val before = sent.size
            call()
            val sentByCall = sent.drop(before)
            assertEquals(listOf(Sent(method, caller)), sentByCall, "frames sent by the call that sends $method")
        }
    }

    @Test
    fun `operations across services issued while attached reach the socket in call order`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)

        val expected = issueAcrossServices()

        assertEquals(expected, sent.map { it.method })
        assertEquals(setOf(Thread.currentThread()), sent.map { it.thread }.toSet())
    }

    @Test
    fun `operations across services held during a reconnect are sent in call order`() = runBlocking {
        awaitState(BridgeConnectionState.ATTACHED)
        bridge.refuseConnections = true
        bridge.current.drop()
        awaitState(BridgeConnectionState.INTERRUPTED)

        val expected = issueAcrossServices()
        assertEquals(emptyList<Sent>(), sent.toList(), "nothing is sent while interrupted")
        awaitedCount = expected.size
        bridge.refuseConnections = false
        withTimeout(10_000) { allSent.await() }

        assertEquals(expected, sent.map { it.method })
    }

    /** Auth, Firestore and Realtime Database reads and writes interleaved from this thread. Returns the methods it expects, in order. */
    private fun issueAcrossServices(): List<String> {
        val doc = firestore.document("rooms/a")
        val ref = database.getReference("rooms/a")
        auth.signInAnonymously()
        doc.set(mapOf("v" to 1))
        doc.get()
        ref.setValue(1)
        ref.get()
        firestore.collection("rooms").count().get()
        auth.signOut()
        doc.get()
        return listOf(
            "auth.signInAnonymously",
            "setDoc",
            "getDoc",
            "rtdb.set",
            "rtdb.get",
            "count",
            "auth.signOut",
            "getDoc"
        )
    }
}
