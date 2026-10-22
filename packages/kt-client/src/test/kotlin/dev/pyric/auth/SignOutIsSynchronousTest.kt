package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * `FirebaseAuth.signOut()` is synchronous in the Firebase Android SDK: when it
 * returns, `currentUser` is null and the next request is unauthenticated. Here
 * the host has not answered `auth.signOut` yet, as on a real socket.
 */
class SignOutIsSynchronousTest {
    private val transport = InMemoryBridgeTransport()
    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val withheldSignOuts = CopyOnWriteArrayList<String>()

    private fun start(): Pair<FirebaseAuth, FirebaseFirestore> {
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    when (op["method"]) {
                        "auth.signInEmail" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-alice","email":"alice@example.com","isAnonymous":false},"operationType":"signIn"}}"""
                        )
                        "auth.signOut" -> withheldSignOuts.add(id)
                        "getDoc" -> transport.sendToClient(
                            """{"type":"worker-res","id":"$id","ok":true,"value":{"id":"a","path":"items/a","exists":false}}"""
                        )
                    }
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "sign-out-sync",
            FirebaseOptions.Builder().setProjectId("demo").setApiKey("k").setApplicationId("a").build(),
        )
        val bridge = PyricBridgeClient(transport)
        val auth = FirebaseAuth.getInstance(app, bridge)
        return auth to FirebaseFirestore(bridge, app, "(default)", credentialsProvider = auth)
    }

    @AfterEach
    fun tearDown() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
    }

    @Test
    fun currentUserIsNullAndTheNextRequestIsAnonymousWhenSignOutReturns() {
        val (auth, firestore) = start()
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret"))
        assertEquals("user-alice", auth.currentUser?.uid)

        auth.signOut()

        assertNull(auth.currentUser?.uid, "currentUser after signOut() returned")
        firestore.document("items/a").get()
        val deadline = System.currentTimeMillis() + 2_000
        while (sentOps.none { it["method"] == "getDoc" } && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(mapOf("mode" to "anon"), sentOps.first { it["method"] == "getDoc" }["actAs"])
    }
}
