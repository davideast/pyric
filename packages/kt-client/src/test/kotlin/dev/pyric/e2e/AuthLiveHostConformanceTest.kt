package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthInvalidUserException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.FirebaseAuthWeakPasswordException
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthCredential
import com.google.firebase.auth.OAuthProvider
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.auth.auth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.database.FirebaseDatabase
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class AuthLiveHostConformanceTest {
    private var liveBridgeUrl: String? = null

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping live-host Kotlin Auth conformance test"
        )
        liveBridgeUrl = envUrl
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        liveBridgeUrl = null
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("auth-kotlin#1..5: instance lifecycle, KTX, shared FirebaseApp bridge, tenantId, clearInstancesForTest")
    fun `proves FirebaseAuth instance lifecycle, shared bridge socket, tenant scope, and test reset`() {
        // auth-kotlin#1: default instance and Firebase.auth KTX extension
        FirebaseApp.initializeApp(
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-default-key")
                .setApplicationId("dev.pyric.live.default")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        val defaultAuth = FirebaseAuth.getInstance()
        assertSame(defaultAuth, Firebase.auth)
        assertSame(FirebaseApp.getInstance(), defaultAuth.app)

        // auth-kotlin#2 and auth-kotlin#3: named FirebaseApp isolation + shared PyricBridgeClient
        val appAlpha = FirebaseApp.initializeApp(
            "kotlin-auth-alpha",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-alpha-key")
                .setApplicationId("dev.pyric.live.alpha")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        val appBeta = FirebaseApp.initializeApp(
            "kotlin-auth-beta",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-beta-key")
                .setApplicationId("dev.pyric.live.beta")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        val authAlpha = FirebaseAuth.getInstance(appAlpha)
        val authBeta = Firebase.auth(appBeta)
        assertSame(authAlpha, Firebase.auth(appAlpha))
        assertNotEquals(authAlpha, authBeta)
        assertSame(appAlpha, authAlpha.app)
        assertSame(appBeta, authBeta.app)

        // Shared bridge socket per FirebaseApp across Auth and Firestore
        val firestoreAlpha = FirebaseFirestore.getInstance(appAlpha)
        val firestoreBeta = FirebaseFirestore.getInstance(appBeta)
        assertSame(authAlpha.bridgeClient, firestoreAlpha.bridgeClient)
        assertNotEquals(authAlpha.bridgeClient, firestoreBeta.bridgeClient)

        // auth-kotlin#4: tenantId configures tenant scope and enforces live Firestore tenant rules
        authAlpha.tenantId = "tenant-alpha"
        assertEquals("tenant-alpha", authAlpha.tenantId)
        val email = "tenant-${System.nanoTime()}@example.com"
        val created = Tasks.await(
            authAlpha.createUserWithEmailAndPassword(email, "TenantPass!123"),
            10,
            TimeUnit.SECONDS
        )
        val tenantUser = requireNotNull(created.user)
        assertEquals("tenant-alpha", tenantUser.tenantId)
        assertNull(authBeta.currentUser)

        val lens = authAlpha.getEffectiveLens() as AuthLens.AsUser
        assertEquals("tenant-alpha", lens.tenant)

        Tasks.await(
            firestoreAlpha.document("tenant_rooms/tenant-alpha/rooms/room-1")
                .set(mapOf("name" to "Alpha Room")),
            10,
            TimeUnit.SECONDS
        )
        val roomSnap = Tasks.await(
            firestoreAlpha.document("tenant_rooms/tenant-alpha/rooms/room-1").get(),
            10,
            TimeUnit.SECONDS
        )
        assertTrue(roomSnap.exists())
        assertEquals("Alpha Room", roomSnap.getString("name"))

        assertFirestoreDenied {
            Tasks.await(
                firestoreAlpha.document("tenant_rooms/tenant-beta/rooms/room-1")
                    .set(mapOf("name" to "Wrong Tenant")),
                10,
                TimeUnit.SECONDS
            )
        }

        // auth-kotlin#5: clearInstancesForTest resets cached FirebaseAuth instances
        FirebaseAuth.clearInstancesForTest()
        val resetAlpha = FirebaseAuth.getInstance(appAlpha)
        assertNotEquals(authAlpha, resetAlpha)
        assertNull(resetAlpha.currentUser)
    }

    @Test
    @DisplayName("auth-kotlin#6..10: signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously, signOut, currentUser, customToken")
    fun `proves authentication operations, standard JWT claims with empty customClaims, and signInWithCustomToken`() {
        val app = newLiveApp("kotlin-auth-ops")
        val auth = FirebaseAuth.getInstance(app)
        val firestore = FirebaseFirestore.getInstance(app)
        val mainDb = FirebaseDatabase.getInstance(app, auth.bridgeClient)

        // auth-kotlin#10: initially unauthenticated
        assertNull(auth.currentUser)

        // auth-kotlin#7: createUserWithEmailAndPassword
        val email = "ops-${System.nanoTime()}@example.com"
        val password = "OpsPassword!123"
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(email, password),
            10,
            TimeUnit.SECONDS
        )
        val owner = requireNotNull(created.user)
        val ownerUid = owner.uid
        assertTrue(ownerUid.isNotBlank())
        assertEquals(ownerUid, auth.currentUser?.uid)
        assertTrue(created.additionalUserInfo?.isNewUser == true)
        assertEquals("password", created.additionalUserInfo?.providerId)
        assertTrue(owner.customClaims.isEmpty())

        // Standard JWT claims (email, email_verified, firebase.sign_in_provider) work immediately
        // in both Firestore and RTDB rules even when customClaims is empty.
        Tasks.await(
            firestore.document("provider_profiles/password/users/$ownerUid")
                .set(mapOf("email" to email)),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            mainDb.getReference("provider_claims/password/$ownerUid")
                .setValue(mapOf("active" to true)),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            mainDb.getReference("email_claims/$ownerUid")
                .setValue(mapOf("pendingVerification" to true)),
            10,
            TimeUnit.SECONDS
        )

        // auth-kotlin#9: signOut synchronously clears currentUser and resets AuthLens to Anon
        auth.signOut()
        assertNull(auth.currentUser)
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
        assertFirestoreDenied {
            Tasks.await(
                firestore.document("users/$ownerUid").set(mapOf("blocked" to true)),
                10,
                TimeUnit.SECONDS
            )
        }

        // auth-kotlin#6: signInWithEmailAndPassword re-establishes session
        val signedIn = Tasks.await(
            auth.signInWithEmailAndPassword(email, password),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(ownerUid, signedIn.user?.uid)
        assertEquals(ownerUid, auth.currentUser?.uid)
        assertFalse(signedIn.additionalUserInfo?.isNewUser == true)
        Tasks.await(
            firestore.document("users/$ownerUid").set(mapOf("restored" to true)),
            10,
            TimeUnit.SECONDS
        )

        // auth-kotlin#8: signInAnonymously establishes anonymous FirebaseUser session
        auth.signOut()
        val anonResult = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
        val anonUser = requireNotNull(anonResult.user)
        assertTrue(anonUser.isAnonymous)
        assertNull(anonUser.email)
        assertEquals(anonUser.uid, auth.currentUser?.uid)
        assertNotEquals(ownerUid, anonUser.uid)
        Tasks.await(
            firestore.document("provider_profiles/anonymous/users/${anonUser.uid}")
                .set(mapOf("guest" to true)),
            10,
            TimeUnit.SECONDS
        )
        assertFirestoreDenied {
            Tasks.await(
                firestore.document("users/$ownerUid").get(),
                10,
                TimeUnit.SECONDS
            )
        }

        // Custom token sign-in and error code parity against live host
        val validCustomToken = System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID")
        if (!validCustomToken.isNullOrBlank()) {
            auth.signOut()
            val customResult = Tasks.await(
                auth.signInWithCustomToken(validCustomToken),
                10,
                TimeUnit.SECONDS
            )
            val customUser = requireNotNull(customResult.user)
            assertEquals("kt-custom-uid-01", customUser.uid)
            assertEquals("moderator", customUser.customClaims["role"])
            assertEquals("pro", customUser.customClaims["tier"])
            assertNull(customResult.additionalUserInfo?.providerId)
            Tasks.await(
                firestore.document("provider_profiles/custom/users/kt-custom-uid-01")
                    .set(mapOf("source" to "custom-token")),
                10,
                TimeUnit.SECONDS
            )
            Tasks.await(
                firestore.document("role_items/moderator/items/item-1")
                    .set(mapOf("approved" to true)),
                10,
                TimeUnit.SECONDS
            )
        }

        val mismatchCustomToken = System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_MISMATCH")
        if (!mismatchCustomToken.isNullOrBlank()) {
            val mismatchCause = expectAuthException {
                Tasks.await(auth.signInWithCustomToken(mismatchCustomToken), 10, TimeUnit.SECONDS)
            }
            assertTrue(mismatchCause is FirebaseAuthInvalidCredentialsException)
            assertEquals("ERROR_CUSTOM_TOKEN_MISMATCH", mismatchCause.errorCode)
        }

        val invalidCause = expectAuthException {
            Tasks.await(auth.signInWithCustomToken("not-a-valid-custom-token"), 10, TimeUnit.SECONDS)
        }
        assertTrue(invalidCause is FirebaseAuthInvalidCredentialsException)
        assertEquals("ERROR_INVALID_CUSTOM_TOKEN", invalidCause.errorCode)
    }

    @Test
    @DisplayName("auth-kotlin#11..14: authStateFlow, idTokenFlow, addAuthStateListener, addIdTokenListener")
    fun `proves Coroutine Flows and listener registration, refresh, and removal against live host`() = runBlocking {
        val app = newLiveApp("kotlin-auth-observers")
        val auth = FirebaseAuth.getInstance(app)

        val flowAuthEvents = CopyOnWriteArrayList<String?>()
        val flowIdTokenEvents = CopyOnWriteArrayList<String?>()
        val collectorScope = CoroutineScope(Dispatchers.IO)

        // auth-kotlin#11 and auth-kotlin#12
        val authFlowJob = collectorScope.launch {
            auth.authStateFlow().collect { u -> flowAuthEvents.add(u?.uid) }
        }
        val idTokenFlowJob = collectorScope.launch {
            auth.idTokenFlow().collect { u -> flowIdTokenEvents.add(u?.uid) }
        }

        awaitCondition { flowAuthEvents.isNotEmpty() && flowIdTokenEvents.isNotEmpty() }
        assertEquals(listOf<String?>(null), flowAuthEvents.toList())
        assertEquals(listOf<String?>(null), flowIdTokenEvents.toList())

        // auth-kotlin#13 and auth-kotlin#14
        val authListenerEvents = CopyOnWriteArrayList<String?>()
        val idTokenListenerEvents = CopyOnWriteArrayList<String?>()
        val authListener = FirebaseAuth.AuthStateListener { a ->
            authListenerEvents.add(a.currentUser?.uid)
        }
        val idTokenListener = FirebaseAuth.IdTokenListener { a ->
            idTokenListenerEvents.add(a.currentUser?.uid)
        }
        auth.addAuthStateListener(authListener)
        auth.addIdTokenListener(idTokenListener)
        assertEquals(listOf<String?>(null), authListenerEvents.toList())
        assertEquals(listOf<String?>(null), idTokenListenerEvents.toList())

        try {
            val email = "flow-${System.nanoTime()}@example.com"
            val user = requireNotNull(
                Tasks.await(
                    auth.createUserWithEmailAndPassword(email, "FlowPass!123"),
                    10,
                    TimeUnit.SECONDS
                ).user
            )
            val uid = user.uid

            awaitCondition {
                flowAuthEvents.contains(uid) &&
                    flowIdTokenEvents.contains(uid) &&
                    authListenerEvents.contains(uid) &&
                    idTokenListenerEvents.contains(uid)
            }
            val authStateCountBeforeRefresh = authListenerEvents.size
            val idTokenCountBeforeRefresh = idTokenListenerEvents.size
            val idTokenFlowCountBeforeRefresh = flowIdTokenEvents.size

            // Force refresh triggers idToken listeners/flow without firing authState transitions
            val refreshLatch = CountDownLatch(1)
            val probeCalls = java.util.concurrent.atomic.AtomicInteger(0)
            val refreshProbe = FirebaseAuth.IdTokenListener {
                if (probeCalls.incrementAndGet() >= 2) {
                    refreshLatch.countDown()
                }
            }
            auth.addIdTokenListener(refreshProbe)
            try {
                Tasks.await(user.getIdToken(true), 10, TimeUnit.SECONDS)
                assertTrue(refreshLatch.await(10, TimeUnit.SECONDS))
            } finally {
                auth.removeIdTokenListener(refreshProbe)
            }

            awaitCondition { flowIdTokenEvents.size > idTokenFlowCountBeforeRefresh }
            assertEquals(authStateCountBeforeRefresh, authListenerEvents.size)
            assertTrue(idTokenListenerEvents.size > idTokenCountBeforeRefresh)

            // Sign out emits null on both listeners and flows
            auth.signOut()
            awaitCondition {
                flowAuthEvents.lastOrNull() == null &&
                    flowIdTokenEvents.lastOrNull() == null &&
                    authListenerEvents.lastOrNull() == null &&
                    idTokenListenerEvents.lastOrNull() == null
            }

            // Removal stops subsequent notifications
            auth.removeAuthStateListener(authListener)
            auth.removeIdTokenListener(idTokenListener)
            val frozenAuthSize = authListenerEvents.size
            val frozenTokenSize = idTokenListenerEvents.size

            Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
            assertEquals(frozenAuthSize, authListenerEvents.size)
            assertEquals(frozenTokenSize, idTokenListenerEvents.size)
        } finally {
            auth.removeAuthStateListener(authListener)
            auth.removeIdTokenListener(idTokenListener)
            authFlowJob.cancel()
            idTokenFlowJob.cancel()
            collectorScope.cancel()
        }
    }

    @Test
    @DisplayName("auth-kotlin#15..24: FirebaseUser identity, profile properties, providerData, and customClaims")
    fun `proves FirebaseUser properties, providerData, verified OAuth identity, and customClaims on live host`() {
        val app = newLiveApp("kotlin-user-identity")
        val auth = FirebaseAuth.getInstance(app)
        val firestore = FirebaseFirestore.getInstance(app)

        val email = "identity-${System.nanoTime()}@example.com"
        val created = Tasks.await(
            auth.createUserWithEmailAndPassword(email, "IdentityPass!123"),
            10,
            TimeUnit.SECONDS
        )
        val emailUser = requireNotNull(created.user)

        // auth-kotlin#15..23 on email/password user
        assertTrue(emailUser.uid.isNotBlank())
        assertEquals(email, emailUser.email)
        assertNull(emailUser.displayName)
        assertNull(emailUser.photoUrl)
        assertNull(emailUser.phoneNumber)
        assertFalse(emailUser.isAnonymous)
        assertFalse(emailUser.isEmailVerified)
        assertEquals("firebase", emailUser.providerId)
        assertEquals(listOf("firebase", "password"), emailUser.providerData.map { it.providerId })
        assertEquals(emailUser.uid, emailUser.providerData[0].uid)
        assertEquals(email, emailUser.providerData[0].email)
        assertEquals(email, emailUser.providerData[1].email)
        assertTrue(emailUser.customClaims.isEmpty())

        // Mutate profile and reload over live host to verify non-null displayName and photoUrl
        val avatarUri = URI.create("https://example.com/avatars/jordan.png")
        val profileReq = UserProfileChangeRequest.Builder()
            .setDisplayName("Jordan Rivera")
            .setPhotoUri(avatarUri)
            .build()
        Tasks.await(emailUser.updateProfile(profileReq), 10, TimeUnit.SECONDS)
        Tasks.await(emailUser.reload(), 10, TimeUnit.SECONDS)
        assertEquals("Jordan Rivera", emailUser.displayName)
        assertEquals(avatarUri, emailUser.photoUrl)
        assertEquals("Jordan Rivera", emailUser.providerData[0].displayName)
        assertEquals(avatarUri, emailUser.providerData[0].photoUrl)

        // Unverified email user is denied on verified_users/{uid}
        assertFirestoreDenied {
            Tasks.await(
                firestore.document("verified_users/${emailUser.uid}")
                    .set(mapOf("verified" to false)),
                10,
                TimeUnit.SECONDS
            )
        }

        // Anonymous user contrast (auth-kotlin#16, #20, #23)
        auth.signOut()
        val anonUser = requireNotNull(
            Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user
        )
        assertNotEquals(emailUser.uid, anonUser.uid)
        assertNull(anonUser.email)
        assertTrue(anonUser.isAnonymous)
        assertEquals("firebase", anonUser.providerId)
        assertEquals(listOf("firebase"), anonUser.providerData.map { it.providerId })
        assertEquals(anonUser.uid, anonUser.providerData[0].uid)

        // Staged Google OAuth user with emailVerified = true and customClaims (auth-kotlin#21, #23, #24)
        auth.signOut()
        val googleUid = "google-uid-${System.nanoTime()}"
        val googleEmail = "google-${System.nanoTime()}@example.com"
        Tasks.await(
            auth.stageSignInResult(
                providerId = GoogleAuthProvider.PROVIDER_ID,
                uid = googleUid,
                email = googleEmail,
                displayName = "Google Member",
                photoUrl = "https://example.com/avatars/google.png",
                emailVerified = true,
                customClaims = mapOf("role" to "editor", "level" to 3)
            ),
            10,
            TimeUnit.SECONDS
        )
        val googleCred = GoogleAuthProvider.getCredential("google-id-tok", "google-access-tok")
        val googleResult = Tasks.await(auth.signInWithCredential(googleCred), 10, TimeUnit.SECONDS)
        val googleUser = requireNotNull(googleResult.user)
        assertEquals(googleUid, googleUser.uid)
        assertEquals(googleEmail, googleUser.email)
        assertEquals("Google Member", googleUser.displayName)
        assertEquals(URI.create("https://example.com/avatars/google.png"), googleUser.photoUrl)
        assertFalse(googleUser.isAnonymous)
        assertTrue(googleUser.isEmailVerified)
        assertEquals("firebase", googleUser.providerId)
        assertEquals(listOf("firebase", "google.com"), googleUser.providerData.map { it.providerId })

        // Verify email_verified = true satisfies live Firestore verified_users/{uid} rule
        Tasks.await(
            firestore.document("verified_users/$googleUid").set(mapOf("verified" to true)),
            10,
            TimeUnit.SECONDS
        )

        // auth-kotlin#24: customClaims populated on token fetch and carried into AuthLens + rules
        val idTokenRes = Tasks.await(googleUser.getIdTokenResult(false), 10, TimeUnit.SECONDS)
        assertEquals("editor", idTokenRes.claims["role"])
        assertEquals("editor", googleUser.customClaims["role"])
        assertFalse(googleUser.customClaims.containsKey("sub"))
        assertFalse(googleUser.customClaims.containsKey("firebase"))

        val activeLens = auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("editor", activeLens.token?.get("role"))
        Tasks.await(
            firestore.document("role_items/editor/items/doc-1").set(mapOf("editedBy" to googleUid)),
            10,
            TimeUnit.SECONDS
        )
    }

    @Test
    @DisplayName("auth-kotlin#25..29: getIdToken, getIdTokenResult, updateProfile, reload, delete invalidation, and UserProfileChangeRequest.Builder")
    fun `proves token refresh, structured token metadata, profile builder, cross-session reload, and deleted-user invalidation on live host`() {
        runTokenAndProfileLiveHostAssertions()
    }

    @Test
    @DisplayName("auth-kotlin#30..32: AuthResult, AdditionalUserInfo, GetTokenResult, and FirebaseAuthException subclasses")
    fun `proves AuthResult metadata, GetTokenResult timestamps, and FirebaseAuthException subclass parity on live host`() {
        runModelsAndExceptionsLiveHostAssertions()
    }

    @Test
    @DisplayName("auth-kotlin#33..39: CredentialsProvider, authLensFlow, Firestore actAs & snapshots re-subscription, and OAuth providers")
    fun `proves CredentialsProvider lens flow, Firestore actAs stamping and live snapshot re-subscription, and OAuth providers on live host`() {
        runCredentialsAndOAuthLiveHostAssertions()
    }

    private fun newLiveApp(prefix: String): FirebaseApp = newAuthLiveApp(prefix)

    private fun awaitCondition(timeoutMs: Long = 5_000L, predicate: () -> Boolean) =
        awaitAuthCondition(timeoutMs, predicate)

    private fun expectAuthException(block: () -> Unit): FirebaseAuthException =
        expectLiveAuthException(block)

    private fun assertFirestoreDenied(block: () -> Unit) =
        assertLiveFirestoreDenied(block)

    companion object {
        private const val PROJECT_ID = AUTH_LIVE_PROJECT_ID
    }
}
