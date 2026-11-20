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
        Triple("com.google.firebase.database.FirebaseDatabase", "getInstance", emptyList()),
        Triple("com.google.firebase.database.FirebaseDatabase", "getInstance", listOf(String::class.java)),
        Triple("com.google.firebase.database.FirebaseDatabase", "getInstance", listOf(Class.forName("com.google.firebase.FirebaseApp"))),
        Triple("com.google.firebase.database.FirebaseDatabase", "getInstance", listOf(Class.forName("com.google.firebase.FirebaseApp"), String::class.java)),
        Triple("com.google.firebase.database.Transaction", "abort", emptyList()),
        Triple("com.google.firebase.database.Transaction", "success", listOf(Class.forName("com.google.firebase.database.MutableData"))),
        Triple("com.google.firebase.database.ServerValue", "increment", listOf(Long::class.javaPrimitiveType!!)),
        Triple("com.google.firebase.database.ServerValue", "increment", listOf(Double::class.javaPrimitiveType!!)),
        Triple("com.google.firebase.database.DatabaseError", "fromException", listOf(Throwable::class.java)),
        Triple("com.google.firebase.appcheck.FirebaseAppCheck", "getInstance", emptyList()),
        Triple("com.google.firebase.appcheck.FirebaseAppCheck", "getInstance", listOf(Class.forName("com.google.firebase.FirebaseApp"))),
        Triple("com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory", "getInstance", emptyList()),
        Triple("com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory", "getInstance", emptyList()),
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
    fun firebaseDatabaseDropInNamespaceAndKtxExistInBytecode() {
        val requiredTypes = listOf(
            "com.google.firebase.database.FirebaseDatabase",
            "com.google.firebase.database.DatabaseReference",
            "com.google.firebase.database.Query",
            "com.google.firebase.database.DataSnapshot",
            "com.google.firebase.database.MutableData",
            "com.google.firebase.database.Transaction",
            "com.google.firebase.database.Transaction\$Handler",
            "com.google.firebase.database.Transaction\$Result",
            "com.google.firebase.database.OnDisconnect",
            "com.google.firebase.database.ServerValue",
            "com.google.firebase.database.ValueEventListener",
            "com.google.firebase.database.ChildEventListener",
            "com.google.firebase.database.DatabaseError",
            "com.google.firebase.database.DatabaseException",
            "com.google.firebase.database.DatabaseKt",
        )
        val missing = requiredTypes.filter { fqcn ->
            runCatching { Class.forName(fqcn) }.isFailure
        }
        assertEquals(emptyList<String>(), missing)

        val getDatabase = Class.forName("com.google.firebase.database.DatabaseKt")
            .getMethod("getDatabase", Class.forName("com.google.firebase.Firebase"))
        assertTrue(Modifier.isStatic(getDatabase.modifiers))

        val timestampField = Class.forName("com.google.firebase.database.ServerValue")
            .getField("TIMESTAMP")
        assertTrue(Modifier.isStatic(timestampField.modifiers))
        assertEquals(mapOf(".sv" to "timestamp"), timestampField.get(null))

        val addedClass = Class.forName("com.google.firebase.database.ChildEvent\$Added")
        assertNotNullCompat(addedClass.getMethod("component1"))
        assertNotNullCompat(addedClass.getMethod("component2"))
        val removedClass = Class.forName("com.google.firebase.database.ChildEvent\$Removed")
        assertNotNullCompat(removedClass.getMethod("component1"))

        val queryClass = Class.forName("com.google.firebase.database.Query")
        assertNotNullCompat(queryClass.getMethod("equalTo", Any::class.java))
        assertNotNullCompat(queryClass.getMethod("equalTo", Any::class.java, String::class.java))
        assertNotNullCompat(queryClass.getMethod("startAt", Any::class.java))
        assertNotNullCompat(queryClass.getMethod("startAt", Any::class.java, String::class.java))
        assertNotNullCompat(queryClass.getMethod("startAfter", Any::class.java))
        assertNotNullCompat(queryClass.getMethod("startAfter", Any::class.java, String::class.java))
        assertNotNullCompat(queryClass.getMethod("endAt", Any::class.java))
        assertNotNullCompat(queryClass.getMethod("endAt", Any::class.java, String::class.java))
        assertNotNullCompat(queryClass.getMethod("endBefore", Any::class.java))
        assertNotNullCompat(queryClass.getMethod("endBefore", Any::class.java, String::class.java))

        val snapClass = Class.forName("com.google.firebase.database.DataSnapshot")
        assertNotNullCompat(snapClass.getMethod("getValue"))
        assertNotNullCompat(snapClass.getMethod("getValue", Boolean::class.javaPrimitiveType))
        assertNotNullCompat(snapClass.getMethod("getValue", Class::class.java))
    }

    @Test
    fun firebaseAppCheckDropInNamespaceAndKtxExistInBytecode() {
        val requiredTypes = listOf(
            "com.google.firebase.FirebaseException",
            "com.google.firebase.appcheck.FirebaseAppCheck",
            "com.google.firebase.appcheck.FirebaseAppCheck\$AppCheckListener",
            "com.google.firebase.appcheck.AppCheckToken",
            "com.google.firebase.appcheck.AppCheckProvider",
            "com.google.firebase.appcheck.AppCheckProviderFactory",
            "com.google.firebase.appcheck.FirebaseAppCheckKt",
            "com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory",
            "com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory",
        )
        val missing = requiredTypes.filter { fqcn ->
            runCatching { Class.forName(fqcn) }.isFailure
        }
        assertEquals(emptyList<String>(), missing)

        val appCheckClass = Class.forName("com.google.firebase.appcheck.FirebaseAppCheck")
        val factoryClass = Class.forName("com.google.firebase.appcheck.AppCheckProviderFactory")
        val listenerClass = Class.forName("com.google.firebase.appcheck.FirebaseAppCheck\$AppCheckListener")
        assertNotNullCompat(appCheckClass.getMethod("installAppCheckProviderFactory", factoryClass))
        assertNotNullCompat(
            appCheckClass.getMethod(
                "installAppCheckProviderFactory",
                factoryClass,
                Boolean::class.javaPrimitiveType
            )
        )
        assertNotNullCompat(appCheckClass.getMethod("getAppCheckToken", Boolean::class.javaPrimitiveType))
        assertNotNullCompat(appCheckClass.getMethod("getLimitedUseAppCheckToken"))
        assertNotNullCompat(appCheckClass.getMethod("addAppCheckListener", listenerClass))
        assertNotNullCompat(appCheckClass.getMethod("removeAppCheckListener", listenerClass))
        assertNotNullCompat(
            appCheckClass.getMethod("setTokenAutoRefreshEnabled", Boolean::class.javaPrimitiveType)
        )

        val tokenClass = Class.forName("com.google.firebase.appcheck.AppCheckToken")
        assertNotNullCompat(tokenClass.getMethod("getToken"))
        assertNotNullCompat(tokenClass.getMethod("getExpireTimeMillis"))

        val ktxClass = Class.forName("com.google.firebase.appcheck.FirebaseAppCheckKt")
        val getAppCheck = ktxClass.getMethod("getAppCheck", Class.forName("com.google.firebase.Firebase"))
        assertTrue(Modifier.isStatic(getAppCheck.modifiers))
        assertNotNullCompat(
            ktxClass.getMethod(
                "appCheck",
                Class.forName("com.google.firebase.Firebase"),
                Class.forName("com.google.firebase.FirebaseApp")
            )
        )
        assertNotNullCompat(ktxClass.getMethod("component1", tokenClass))
        assertNotNullCompat(ktxClass.getMethod("component2", tokenClass))
    }

    private fun assertNotNullCompat(value: Any?) {
        assertTrue(value != null)
    }

    @Test
    fun rtdbPermissionDeniedTasksThrowDatabaseException() {
        com.google.firebase.database.FirebaseDatabase.clearInstancesForTest()
        val transport = InMemoryBridgeTransport()
        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                "worker-op" -> transport.sendToClient(
                    """{"type":"worker-res","id":"${msg["id"]}","ok":false,"error":{"code":"PERMISSION_DENIED","message":"PERMISSION_DENIED: Permission denied"}}"""
                )
            }
        }
        val app = FirebaseApp.initializeApp(
            "abi-rtdb-${System.nanoTime()}",
            FirebaseOptions.Builder().setProjectId("demo").setApiKey("k").setApplicationId("a").build(),
        )
        val db = com.google.firebase.database.FirebaseDatabase.getInstance(app, PyricBridgeClient(transport))
        val ref = db.getReference("rooms/r1")

        val getCause = assertThrows<ExecutionException> { Tasks.await(ref.get()) }.cause!!
        assertEquals("com.google.firebase.database.DatabaseException", getCause.javaClass.name)
        assertEquals(
            com.google.firebase.database.DatabaseError.PERMISSION_DENIED,
            com.google.firebase.database.DatabaseError.fromException(getCause).code,
        )

        val setCause = assertThrows<ExecutionException> { Tasks.await(ref.setValue("denied")) }.cause!!
        assertEquals("com.google.firebase.database.DatabaseException", setCause.javaClass.name)
        assertEquals(
            com.google.firebase.database.DatabaseError.PERMISSION_DENIED,
            com.google.firebase.database.DatabaseError.fromException(setCause).code,
        )

        val onDisconnectCause = assertThrows<ExecutionException> {
            Tasks.await(ref.onDisconnect().setValue("denied"))
        }.cause!!
        assertEquals("com.google.firebase.database.DatabaseException", onDisconnectCause.javaClass.name)
        com.google.firebase.database.FirebaseDatabase.clearInstancesForTest()
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
