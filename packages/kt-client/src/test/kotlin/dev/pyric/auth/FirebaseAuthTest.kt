package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.UserProfileChangeRequest
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class FirebaseAuthTest {

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()

    @BeforeEach
    fun setUp() {
        FirebaseAuth.clearInstancesForTest()
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
                            val password = op["password"] as? String
                            if (password == "wrong-password") {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/wrong-password","message":"wrong-password"}}"""
                                )
                            } else if (password == "operation-not-allowed" || password == "user-disabled" || password == "invalid-credential" || password == "requires-recent-login" || password == "too-many-requests") {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/$password","message":"$password"}}"""
                                )
                            } else if (email == "claims@example.com") {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-claims","email":"$email","displayName":"Claims User","emailVerified":true,"isAnonymous":false,"providerId":"password","customClaims":{"role":"editor","plan":"pro"}},"providerId":"password","operationType":"signIn"}}"""
                                )
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-alice","email":"$email","displayName":"Alice","emailVerified":true,"isAnonymous":false,"providerId":"password"},"providerId":"password","operationType":"signIn"}}"""
                                )
                            }
                        }
                        "auth.createUser" -> {
                            val email = op["email"] as? String
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"user-bob","email":"$email","displayName":"Bob","emailVerified":false,"isAnonymous":false,"providerId":"password"},"providerId":"password","operationType":"signIn"}}"""
                            )
                        }
                        "auth.signInAnonymously" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"anon-123","email":null,"displayName":null,"isAnonymous":true,"providerId":"firebase"},"providerId":null,"operationType":"signIn"}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.getIdToken" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":"mock.jwt.token"}""")
                        }
                        "auth.getIdTokenResult" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"mock.jwt.token","claims":{"role":"admin","sub":"user-alice"},"expirationTime":1800000000,"authTime":1700000000,"issuedAtTime":1700000000,"signInProvider":"password"}}"""
                            )
                        }
                        "auth.updateProfile" -> {
                            val displayName = op["displayName"] as? String
                            val photoURL = op["photoURL"] as? String
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","email":"alice@example.com","displayName":"$displayName","photoURL":"$photoURL","emailVerified":true,"isAnonymous":false,"providerId":"password"}}"""
                            )
                        }
                        "auth.getCurrentUser" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","email":"alice@example.com","displayName":"Alice Reloaded","emailVerified":true,"isAnonymous":false,"providerId":"password"}}"""
                            )
                        }
                        else -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    val target = sub["target"] as? String
                    if (target == "authState") {
                        // Subscribed to authState
                    }
                }
            }
        }

        app = FirebaseApp.initializeApp(
            "auth-test-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-auth")
                .setApiKey("fake-key")
                .setApplicationId("fake-app")
                .build()
        )
        auth = FirebaseAuth.getInstance(app, bridgeClient)
    }

    @AfterEach
    fun tearDown() {
        FirebaseAuth.clearInstancesForTest()
    }

    @Test
    fun testSignInWithEmailAndPasswordSuccess() {
        val listenerEvents = CopyOnWriteArrayList<FirebaseUser?>()
        auth.addAuthStateListener { a -> listenerEvents.add(a.currentUser) }

        val task = auth.signInWithEmailAndPassword("alice@example.com", "secret123")
        val result = Tasks.await(task)

        assertNotNull(result.user)
        assertEquals("user-alice", result.user?.uid)
        assertEquals("alice@example.com", result.user?.email)
        assertEquals("Alice", result.user?.displayName)
        assertTrue(result.user?.isEmailVerified == true)
        assertFalse(result.user?.isAnonymous == true)

        assertEquals("user-alice", auth.currentUser?.uid)
        assertEquals(AuthLens.AsUser(uid = "user-alice"), auth.getEffectiveLens())

        // Verify listener saw initial (null) and updated user
        assertTrue(listenerEvents.size >= 2)
        assertEquals("user-alice", listenerEvents.last()?.uid)

        val lastOp = sentOps.find { it["method"] == "auth.signInEmail" }
        assertNotNull(lastOp)
        assertEquals("alice@example.com", lastOp?.get("email"))
        assertEquals("secret123", lastOp?.get("password"))
    }

    @Test
    fun testSignInWithEmailAndPasswordFailure() {
        val task = auth.signInWithEmailAndPassword("alice@example.com", "wrong-password")
        val ex = assertThrows<ExecutionException> {
            Tasks.await(task)
        }
        val cause = ex.cause
        assertTrue(cause is FirebaseAuthException)
        val authEx = cause as FirebaseAuthException
        assertEquals("ERROR_WRONG_PASSWORD", authEx.errorCode)
        assertNull(auth.currentUser)
    }

    @Test
    fun testCreateUserWithEmailAndPassword() {
        val task = auth.createUserWithEmailAndPassword("bob@example.com", "pass456")
        val result = Tasks.await(task)

        assertNotNull(result.user)
        assertEquals("user-bob", result.user?.uid)
        assertEquals("bob@example.com", result.user?.email)
        assertEquals("Bob", result.user?.displayName)

        val lastOp = sentOps.find { it["method"] == "auth.createUser" }
        assertNotNull(lastOp)
        assertEquals("bob@example.com", lastOp?.get("email"))
        assertEquals("pass456", lastOp?.get("password"))
    }

    @Test
    fun testSignInAnonymously() {
        val task = auth.signInAnonymously()
        val result = Tasks.await(task)

        assertNotNull(result.user)
        assertEquals("anon-123", result.user?.uid)
        assertTrue(result.user?.isAnonymous == true)
        assertNull(result.user?.email)

        val lastOp = sentOps.find { it["method"] == "auth.signInAnonymously" }
        assertNotNull(lastOp)
    }

    @Test
    fun testSignOut() {
        Tasks.await(auth.signInAnonymously())
        assertNotNull(auth.currentUser)
        assertEquals(AuthLens.AsUser(uid = "anon-123"), auth.getEffectiveLens())

        auth.signOut()
        Thread.sleep(50)

        assertNull(auth.currentUser)
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())

        val lastOp = sentOps.find { it["method"] == "auth.signOut" }
        assertNotNull(lastOp)
    }

    @Test
    fun testAuthStateFlow() = runBlocking {
        assertEquals(null, auth.authStateFlow().first())

        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        assertEquals("user-alice", auth.authStateFlow().first()?.uid)

        auth.signOut()
        Thread.sleep(50)
        assertEquals(null, auth.authStateFlow().first())
    }

    @Test
    fun testIdTokenFlow() = runBlocking {
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = auth.idTokenFlow().first()
        assertEquals("user-alice", user?.uid)
    }

    @Test
    fun testUpdateProfile() {
        val authResult = Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = authResult.user!!

        val req = UserProfileChangeRequest.Builder()
            .setDisplayName("Alice Updated")
            .setPhotoUri(URI.create("https://example.com/alice.png"))
            .build()

        Tasks.await(user.updateProfile(req))

        assertEquals("Alice Updated", user.displayName)
        assertEquals(URI.create("https://example.com/alice.png"), user.photoUrl)
        assertEquals("Alice Updated", auth.currentUser?.displayName)

        val lastOp = sentOps.find { it["method"] == "auth.updateProfile" }
        assertNotNull(lastOp)
        assertEquals("Alice Updated", lastOp?.get("displayName"))
        assertEquals("https://example.com/alice.png", lastOp?.get("photoURL"))
    }

    @Test
    fun testGetIdTokenAndResult() {
        val authResult = Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = authResult.user!!

        val tokenResult = Tasks.await(user.getIdToken(forceRefresh = true))
        assertEquals("mock.jwt.token", tokenResult.token)
        assertEquals("admin", tokenResult.claims["role"])
        assertEquals("user-alice", tokenResult.claims["sub"])
        assertEquals(1800000000L, tokenResult.expirationTimestamp)
        assertEquals("password", tokenResult.signInProvider)

        val lastOp = sentOps.find { it["method"] == "auth.getIdTokenResult" }
        assertNotNull(lastOp)
        assertEquals(true, lastOp?.get("forceRefresh"))
    }

    @Test
    fun testReloadUser() {
        val authResult = Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = authResult.user!!

        Tasks.await(user.reload())
        assertEquals("Alice Reloaded", user.displayName)
        assertEquals("Alice Reloaded", auth.currentUser?.displayName)

        val lastOp = sentOps.find { it["method"] == "auth.getCurrentUser" }
        assertNotNull(lastOp)
    }

    @Test
    fun testTenantIdPropagation() {
        Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        auth.tenantId = "tenant-xyz"

        val lens = auth.getEffectiveLens()
        assertTrue(lens is AuthLens.AsUser)
        val asUser = lens as AuthLens.AsUser
        assertEquals("tenant-xyz", asUser.tenant)
        assertEquals("tenant-xyz", asUser.toMap()["tenant"])
    }

    @Test
    fun testAuthLensAsUserToMapMergesClaims() {
        val lens = AuthLens.AsUser(
            uid = "user-alice",
            token = mapOf("role" to "admin", "premium" to true)
        )
        val map = lens.toMap()
        assertEquals("as", map["mode"])
        assertEquals("user-alice", map["uid"])
        @Suppress("UNCHECKED_CAST")
        val token = map["token"] as Map<String, Any?>
        assertEquals("user-alice", token["sub"])
        assertEquals("user-alice", token["user_id"])
        assertEquals("admin", token["role"])
        assertEquals(true, token["premium"])
    }

    @Test
    fun testCustomClaimsCarriedInAuthLensAndTokenResult() {
        val task = auth.signInWithEmailAndPassword("claims@example.com", "secret123")
        val result = Tasks.await(task)

        assertNotNull(result.user)
        assertEquals("user-claims", result.user?.uid)
        assertEquals("editor", result.user?.customClaims?.get("role"))
        assertEquals("pro", result.user?.customClaims?.get("plan"))

        val lens = auth.getEffectiveLens()
        assertTrue(lens is AuthLens.AsUser)
        val asUser = lens as AuthLens.AsUser
        assertEquals(mapOf("role" to "editor", "plan" to "pro"), asUser.token)

        val wireMap = asUser.toMap()
        @Suppress("UNCHECKED_CAST")
        val wireToken = wireMap["token"] as Map<String, Any?>
        assertEquals("user-claims", wireToken["sub"])
        assertEquals("user-claims", wireToken["user_id"])
        assertEquals("editor", wireToken["role"])
        assertEquals("pro", wireToken["plan"])
    }

    @Test
    fun testGetIdTokenUpdatesCustomClaimsAndAuthLens() {
        val authResult = Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = authResult.user!!

        // Initially no custom claims
        assertTrue(user.customClaims.isEmpty())
        val initialLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertNull(initialLens.token)

        // Calling getIdToken(forceRefresh = true) receives claims from mock bridge
        val tokenResult = Tasks.await(user.getIdToken(forceRefresh = true))
        assertEquals("admin", tokenResult.claims["role"])
        assertEquals("admin", user.customClaims["role"])

        // AuthLens should now contain the updated claims
        val updatedLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("admin", updatedLens.token?.get("role"))
        val tokenWireMap = updatedLens.toMap()["token"] as Map<*, *>
        assertEquals("admin", tokenWireMap["role"])
        assertEquals("user-alice", tokenWireMap["sub"])
    }

    @Test
    fun testWrapExceptionStandardErrorCodes() {
        val cases = listOf(
            "operation-not-allowed" to "ERROR_OPERATION_NOT_ALLOWED",
            "user-disabled" to "ERROR_USER_DISABLED",
            "invalid-credential" to "ERROR_INVALID_CREDENTIAL",
            "requires-recent-login" to "ERROR_REQUIRES_RECENT_LOGIN",
            "too-many-requests" to "ERROR_TOO_MANY_REQUESTS"
        )
        for ((passwordErr, expectedCode) in cases) {
            val task = auth.signInWithEmailAndPassword("test@example.com", passwordErr)
            val ex = assertThrows<ExecutionException> { Tasks.await(task) }
            val cause = ex.cause
            assertTrue(cause is FirebaseAuthException)
            assertEquals(expectedCode, (cause as FirebaseAuthException).errorCode)
        }
    }

    @Test
    fun testAuthLensFromMap() {
        assertEquals(AuthLens.Admin, AuthLens.fromMap(mapOf("mode" to "admin")))
        assertEquals(AuthLens.AppSession, AuthLens.fromMap(mapOf("mode" to "app-session")))
        assertEquals(AuthLens.Anon, AuthLens.fromMap(mapOf("mode" to "anon")))
        assertEquals(AuthLens.Anon, AuthLens.fromMap(emptyMap()))

        val asUser = AuthLens.fromMap(mapOf("mode" to "as", "uid" to "user-99", "tenant" to "tenant-1", "token" to mapOf("role" to "admin")))
        assertTrue(asUser is AuthLens.AsUser)
        val u = asUser as AuthLens.AsUser
        assertEquals("user-99", u.uid)
        assertEquals("tenant-1", u.tenant)
        assertEquals("admin", u.token?.get("role"))
    }

    @Test
    fun testAuthLensOverrideAndReset() {
        // Initially Anon
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())

        // Set lens override to Admin
        auth.setAuthLens(AuthLens.Admin)
        assertEquals(AuthLens.Admin, auth.getEffectiveLens())
        assertEquals(AuthLens.Admin, auth.lensOverrideFlow.value)

        // Clear lens override
        auth.clearAuthLensOverride()
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
        assertNull(auth.lensOverrideFlow.value)

        // Set lens override to User
        auth.setAuthLens(AuthLens.AsUser("impersonated", tenant = "tenant-xyz"))
        val effective = auth.getEffectiveLens()
        assertTrue(effective is AuthLens.AsUser)
        assertEquals("impersonated", (effective as AuthLens.AsUser).uid)
        assertEquals("tenant-xyz", effective.tenant)
    }

    @Test
    fun testRemoteLensEventFlow() {
        // Send remote lens event from bridge
        val msg = mapOf(
            "type" to "worker-event",
            "event" to "remote-lens",
            "payload" to mapOf(
                "lens" to mapOf(
                    "mode" to "as",
                    "uid" to "remote-uid-1",
                    "token" to mapOf("tier" to "premium")
                )
            )
        )
        transport.sendToClient(JsonCodec.encodeToString(msg))

        // Wait briefly for flow collection
        Thread.sleep(100)

        val lens = auth.getEffectiveLens()
        assertTrue(lens is AuthLens.AsUser)
        assertEquals("remote-uid-1", (lens as AuthLens.AsUser).uid)
        assertEquals("premium", lens.token?.get("tier"))

        // Remote app-session event clears override
        val resetMsg = mapOf(
            "type" to "worker-event",
            "event" to "remote-lens",
            "payload" to mapOf(
                "lens" to mapOf("mode" to "app-session")
            )
        )
        transport.sendToClient(JsonCodec.encodeToString(resetMsg))
        Thread.sleep(100)

        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
    }
}
