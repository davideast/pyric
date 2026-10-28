package dev.pyric

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.DataInputStream
import java.lang.reflect.Modifier
import java.util.concurrent.ExecutionException

/**
 * The JVM entry points an Android app compiled against the Firebase Android
 * SDK (and kotlinx-coroutines-play-services) links to. Each one, when missing,
 * is a NoSuchMethodError or ClassNotFoundException in the app's unit tests.
 */
class JvmAbiCompatibilityTest {
    /** `invokestatic Owner.name(params)`: the method must be static on the class itself. */
    private val staticFactories: List<Triple<String, String, List<Class<*>>>> = listOf(
        Triple("com.google.firebase.FirebaseApp", "getInstance", emptyList()),
        Triple("com.google.firebase.FirebaseApp", "initializeApp", listOf(Class.forName("com.google.firebase.FirebaseOptions"))),
        Triple("com.google.firebase.Timestamp", "now", emptyList()),
        Triple("com.google.firebase.auth.FirebaseAuth", "getInstance", emptyList()),
        Triple("com.google.firebase.firestore.FirebaseFirestore", "getInstance", emptyList()),
        Triple("com.google.firebase.firestore.FieldValue", "serverTimestamp", emptyList()),
        Triple("com.google.firebase.firestore.FieldValue", "delete", emptyList()),
        Triple("com.google.firebase.firestore.FieldValue", "increment", listOf(Long::class.javaPrimitiveType!!)),
        Triple("com.google.firebase.firestore.FieldValue", "arrayUnion", listOf(Array<Any>::class.java)),
        Triple("com.google.firebase.firestore.SetOptions", "merge", emptyList()),
        Triple("com.google.firebase.firestore.FieldPath", "documentId", emptyList()),
        Triple("com.google.firebase.firestore.Filter", "equalTo", listOf(String::class.java, Any::class.java)),
        Triple("com.google.firebase.firestore.Blob", "fromBytes", listOf(ByteArray::class.java)),
        Triple("com.google.firebase.firestore.AggregateField", "count", emptyList()),
        Triple("com.google.firebase.firestore.TransactionOptions", "defaultOptions", emptyList()),
    )

    @Test
    fun companionFactoriesAreStaticOnTheirClass() {
        val missing = staticFactories.filterNot { (owner, name, params) ->
            runCatching { Modifier.isStatic(Class.forName(owner).getMethod(name, *params.toTypedArray()).modifiers) }.getOrDefault(false)
        }.map { (owner, name, _) -> "$owner.$name" }
        assertEquals(emptyList<String>(), missing)
    }

    @Test
    fun taskAwaitCompilesToTasksKt() {
        val await = Class.forName("kotlinx.coroutines.tasks.TasksKt")
            .getMethod("await", Class.forName("com.google.android.gms.tasks.Task"), kotlin.coroutines.Continuation::class.java)
        assertTrue(Modifier.isStatic(await.modifiers))
    }

    @Test
    fun firebaseAuthKtxCompilesToAuthKt() {
        val getAuth = Class.forName("com.google.firebase.auth.AuthKt").getMethod("getAuth", Class.forName("com.google.firebase.Firebase"))
        assertTrue(Modifier.isStatic(getAuth.modifiers))
    }

    @Test
    fun classFilesTargetJava11() {
        val stream = javaClass.classLoader.getResourceAsStream("com/google/firebase/firestore/FieldValue.class")!!
        DataInputStream(stream).use { data ->
            data.readInt() // magic
            data.readUnsignedShort() // minor
            assertEquals(55, data.readUnsignedShort(), "class file major version (55 = Java 11)")
        }
    }

    @AfterEach
    fun tearDown() = FirebaseAuth.clearInstancesForTest()

    @Test
    fun signInErrorsUseTheSdkExceptionSubclasses() {
        FirebaseAuth.clearInstancesForTest()
        val transport = InMemoryBridgeTransport()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> {
                    @Suppress("UNCHECKED_CAST")
                    val code = ((msg["op"] as Map<String, Any?>)["password"] as String)
                    transport.sendToClient("""{"type":"worker-res","id":"${msg["id"]}","ok":false,"error":{"code":"auth/$code","message":"$code"}}""")
                }
            }
        }
        val app = FirebaseApp.initializeApp(
            "abi-auth-${System.nanoTime()}",
            FirebaseOptions.Builder().setProjectId("demo").setApiKey("k").setApplicationId("a").build(),
        )
        val auth = FirebaseAuth.getInstance(app, PyricBridgeClient(transport))
        fun failure(code: String): Throwable =
            assertThrows<ExecutionException> { Tasks.await(auth.signInWithEmailAndPassword("a@example.com", code)) }.cause!!

        // Named by string so this file compiles, and fails by assertion, where the classes are missing.
        val invalidUser = "com.google.firebase.auth.FirebaseAuthInvalidUserException"
        val invalidCredentials = "com.google.firebase.auth.FirebaseAuthInvalidCredentialsException"
        val thrown = listOf("user-not-found", "user-disabled", "wrong-password", "invalid-credential", "too-many-requests")
            .associateWith { failure(it).javaClass.name }
        assertEquals(
            mapOf(
                "user-not-found" to invalidUser,
                "user-disabled" to invalidUser,
                "wrong-password" to invalidCredentials,
                "invalid-credential" to invalidCredentials,
                "too-many-requests" to FirebaseAuthException::class.java.name,
            ),
            thrown,
        )
    }
}
