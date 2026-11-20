package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.firestore.FirebaseFirestore
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
                        "auth.signInWithCustomToken" -> {
                            val customToken = op["customToken"] as? String ?: ""
                            when (customToken) {
                                "mismatch-token" -> transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/custom-token-mismatch","message":"The custom token corresponds to a different audience."}}"""
                                )
                                "invalid-token", "" -> transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/invalid-custom-token","message":"The custom token format is incorrect."}}"""
                                )
                                else -> transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"custom-uid-1","isAnonymous":false,"providerId":"firebase"},"providerId":null,"operationType":"signIn","claims":{"role":"service","sub":"custom-uid-1"}}}"""
                                )
                            }
                        }
                        "auth.mockSignInResult" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.signInWithCredential" -> {
                            val credMap = (op["credential"] as? Map<*, *>) ?: op
                            val providerId = credMap["providerId"] as? String ?: "google.com"
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"staged-google-uid","email":"staged@example.com","displayName":"Staged User","emailVerified":true,"isAnonymous":false,"providerId":"firebase","providerData":[{"uid":"staged-google-uid","email":"staged@example.com","providerId":"$providerId"}]},"providerId":"$providerId","operationType":"signIn","additionalUserInfo":{"isNewUser":true,"providerId":"$providerId"}}}"""
                            )
                        }
                        "auth.signOut" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.getIdToken" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":"mock.jwt.token"}""")
                        }
                        "auth.getIdTokenResult" -> {
                            val forced = op["forceRefresh"] == true
                            val claimsJson = if (forced) {
                                """{"role":"admin","sub":"user-alice"}"""
                            } else {
                                """{"sub":"user-alice"}"""
                            }
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"mock.jwt.token","claims":$claimsJson,"expirationTime":1800000000,"authTime":1700000000,"issuedAtTime":1700000000,"signInProvider":"password"}}"""
                            )
                        }
                        "auth.updateProfile" -> {
                            val displayName = op["displayName"] as? String
                            val photoURL = op["photoURL"] as? String
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","email":"alice@example.com","displayName":"$displayName","photoURL":"$photoURL","emailVerified":true,"isAnonymous":false,"providerId":"password"}}"""
                            )
                        }
                        "auth.getCurrentUser", "auth.reload" -> {
                            if (op["uid"] == "revoked-uid") {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":false,"error":{"code":"auth/user-token-expired","message":"The user credential is no longer valid."}}"""
                                )
                            } else {
                                transport.sendToClient(
                                    """{"type":"worker-res","id":"$id","ok":true,"value":{"uid":"user-alice","email":"alice@example.com","displayName":"Alice Reloaded","emailVerified":true,"isAnonymous":false,"providerId":"password"}}"""
                                )
                            }
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
        val effectiveLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("user-alice", effectiveLens.uid)
        assertEquals("alice@example.com", effectiveLens.token?.get("email"))
        assertEquals(true, effectiveLens.token?.get("email_verified"))
        val firebaseClaims = effectiveLens.token?.get("firebase") as? Map<*, *>
        assertEquals("password", firebaseClaims?.get("sign_in_provider"))

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
        val anonLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("anon-123", anonLens.uid)
        assertEquals("anonymous", anonLens.token?.get("provider_id"))
        assertEquals("anonymous", (anonLens.token?.get("firebase") as? Map<*, *>)?.get("sign_in_provider"))

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

        val lastOp = sentOps.findLast { it["method"] == "auth.getIdTokenResult" }
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

        val lastOp = sentOps.find { it["method"] == "auth.reload" }
        assertNotNull(lastOp)
        assertEquals("user-alice", lastOp?.get("uid"))
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
        assertEquals("editor", asUser.token?.get("role"))
        assertEquals("pro", asUser.token?.get("plan"))
        assertEquals("claims@example.com", asUser.token?.get("email"))
        assertEquals(true, asUser.token?.get("email_verified"))

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

        // Initially no custom claims, while standard JWT claims remain populated
        assertTrue(user.customClaims.isEmpty())
        val initialLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertNull(initialLens.token?.get("role"))
        assertEquals("alice@example.com", initialLens.token?.get("email"))
        assertEquals(true, initialLens.token?.get("email_verified"))
        assertEquals("password", (initialLens.token?.get("firebase") as? Map<*, *>)?.get("sign_in_provider"))

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

    @Test
    fun testSignInWithCustomTokenAndExceptionMappings() {
        auth.tenantId = "tenant-custom"
        val res = Tasks.await(auth.signInWithCustomToken("signed-sandbox-jwt"))
        assertEquals("custom-uid-1", res.user?.uid)
        assertEquals("service", res.user?.customClaims?.get("role"))
        assertNull(res.additionalUserInfo?.providerId)
        val lens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("custom-uid-1", lens.uid)
        assertEquals("tenant-custom", lens.tenant)
        assertEquals("service", lens.token?.get("role"))
        assertEquals("custom", (lens.token?.get("firebase") as? Map<*, *>)?.get("sign_in_provider"))

        val invalidEx = assertThrows<ExecutionException> {
            Tasks.await(auth.signInWithCustomToken("invalid-token"))
        }.cause
        assertTrue(invalidEx is FirebaseAuthInvalidCredentialsException)
        assertEquals("ERROR_INVALID_CUSTOM_TOKEN", (invalidEx as FirebaseAuthException).errorCode)

        val mismatchEx = assertThrows<ExecutionException> {
            Tasks.await(auth.signInWithCustomToken("mismatch-token"))
        }.cause
        assertTrue(mismatchEx is FirebaseAuthInvalidCredentialsException)
        assertEquals("ERROR_CUSTOM_TOKEN_MISMATCH", (mismatchEx as FirebaseAuthException).errorCode)
    }

    @Test
    fun testUserTokenExpiredMapsToInvalidUserExceptionAndClearsSession() {
        val revokedUser = FirebaseUser(auth, mapOf("uid" to "revoked-uid", "isAnonymous" to false))
        val reloadEx = assertThrows<ExecutionException> {
            Tasks.await(revokedUser.reload())
        }.cause
        assertTrue(reloadEx is FirebaseAuthInvalidUserException)
        assertEquals("ERROR_USER_TOKEN_EXPIRED", (reloadEx as FirebaseAuthException).errorCode)
    }

    @Test
    fun testIsoTimestampParsingAndStageSignInResult() {
        assertEquals(1795147200L, FirebaseUser.parseTimestampSeconds("2026-11-20T04:00:00.000Z", null))
        assertEquals(1800000000L, FirebaseUser.parseTimestampSeconds(1800000000, null))
        assertEquals(1795140000L, FirebaseUser.parseTimestampSeconds(null, 1795140000))

        Tasks.await(
            auth.stageSignInResult(
                providerId = GoogleAuthProvider.PROVIDER_ID,
                uid = "staged-google-uid",
                email = "staged@example.com",
                displayName = "Staged User",
                emailVerified = true
            )
        )
        val stageOp = sentOps.find { it["method"] == "auth.mockSignInResult" }
        assertNotNull(stageOp)

        val cred = GoogleAuthProvider.getCredential("google-id", "google-access")
        val signedIn = Tasks.await(auth.signInWithCredential(cred))
        assertEquals("staged-google-uid", signedIn.user?.uid)
        assertEquals("google.com", signedIn.additionalUserInfo?.providerId)
    }

    @Test
    fun testSharedBridgeClientAcrossFirebaseAppServices() {
        val sharedApp = FirebaseApp.initializeApp(
            "shared-bridge-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-shared")
                .setApiKey("key")
                .setApplicationId("app")
                .build()
        )
        val customBridge = PyricBridgeClient(transport)
        val appAuth = FirebaseAuth.getInstance(sharedApp, customBridge)
        val appFirestore = FirebaseFirestore.getInstance(sharedApp)
        assertTrue(appAuth.bridgeClient === customBridge)
        assertTrue(appFirestore.bridgeClient === customBridge)
        FirebaseFirestore.clearInstancesForTest()
    }

    @Test
    fun testInitialNullIdTokenSnapshotDoesNotDuplicateSignedOutEmission() = runBlocking {
        val observed = CopyOnWriteArrayList<String?>()
        val listener = FirebaseAuth.IdTokenListener { a -> observed.add(a.currentUser?.uid) }
        auth.addIdTokenListener(listener)
        assertEquals(listOf<String?>(null), observed.toList())

        val initialSnap = mapOf(
            "type" to "worker-snap",
            "subId" to "sub-id-token-init",
            "value" to null
        )
        transport.sendToClient(JsonCodec.encodeToString(initialSnap))
        Thread.sleep(50)

        assertEquals(listOf<String?>(null), observed.toList())
        auth.removeIdTokenListener(listener)
    }

    @Test
    fun testDeleteUserAndOAuthCredentialBuilderAndNullProfileClearing() {
        val signedIn = Tasks.await(auth.signInWithEmailAndPassword("alice@example.com", "secret123"))
        val user = signedIn.user!!

        val authStates = CopyOnWriteArrayList<String?>()
        val idTokens = CopyOnWriteArrayList<String?>()
        val authListener = FirebaseAuth.AuthStateListener { a -> authStates.add(a.currentUser?.uid) }
        val tokenListener = FirebaseAuth.IdTokenListener { a -> idTokens.add(a.currentUser?.displayName) }
        auth.addAuthStateListener(authListener)
        auth.addIdTokenListener(tokenListener)
        val authCountAfterReg = authStates.size

        // Partial update only sends displayName; explicit null sends null photoURL
        Tasks.await(user.updateProfile(UserProfileChangeRequest.Builder().setDisplayName("Alice Partial").build()))
        val partialOp = sentOps.findLast { it["method"] == "auth.updateProfile" }!!
        assertEquals("Alice Partial", partialOp["displayName"])
        assertFalse(partialOp.containsKey("photoURL"))
        assertEquals(authCountAfterReg, authStates.size)
        assertTrue(idTokens.contains("Alice Partial"))

        Tasks.await(user.updateProfile(UserProfileChangeRequest.Builder().setPhotoUri(null as URI?).build()))
        val clearPhotoOp = sentOps.findLast { it["method"] == "auth.updateProfile" }!!
        assertFalse(clearPhotoOp.containsKey("displayName"))
        assertTrue(clearPhotoOp.containsKey("photoURL"))
        assertNull(clearPhotoOp["photoURL"])

        Tasks.await(user.delete())
        assertNull(auth.currentUser)
        assertNotNull(sentOps.findLast { it["method"] == "auth.deleteUser" })

        val built = com.google.firebase.auth.OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("apple-jwt", "nonce-1")
            .setAccessToken("apple-acc")
            .build() as com.google.firebase.auth.OAuthCredential
        assertEquals("apple.com", built.provider)
        assertEquals("apple-jwt", built.idToken)
        assertEquals("apple-acc", built.accessToken)
        assertEquals("nonce-1", built.rawNonce)

        auth.removeAuthStateListener(authListener)
        auth.removeIdTokenListener(tokenListener)
    }
}
