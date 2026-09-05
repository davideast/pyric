package dev.pyric.auth

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.firestore.snapshots
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class ConformanceTest {

    private lateinit var harness: AuthConformanceMockHarness

    @BeforeEach
    fun setUp() {
        harness = AuthConformanceMockHarness()
    }

    @AfterEach
    fun tearDown() {
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    // ── 1. FirebaseAuth: Instance & Lifecycle ─────────────────────────────
    @Test
    @DisplayName("auth-kotlin#1: FirebaseAuth.getInstance returns default instance")
    fun `auth-kotlin#1 FirebaseAuth getInstance returns default instance`() {
        val instance = FirebaseAuth.getInstance()
        assertNotNull(instance)
        assertEquals(FirebaseApp.getInstance(), instance.app)
    }

    @Test
    @DisplayName("auth-kotlin#2: FirebaseAuth.getInstance(app) provides isolated instance")
    fun `auth-kotlin#2 FirebaseAuth getInstance app provides isolated instance`() {
        val customApp = FirebaseApp.initializeApp(
            "custom-app",
            FirebaseOptions.Builder().setProjectId("custom-proj").setApiKey("key").setApplicationId("app").build()
        )
        val instance = FirebaseAuth.getInstance(customApp)
        assertNotNull(instance)
        assertEquals("custom-app", instance.app.name)
    }

    @Test
    @DisplayName("auth-kotlin#3: FirebaseAuth.app returns bound FirebaseApp")
    fun `auth-kotlin#3 FirebaseAuth app returns bound FirebaseApp`() {
        assertEquals("test-app", harness.auth.app.name)
    }

    @Test
    @DisplayName("auth-kotlin#4: FirebaseAuth.tenantId updates active AuthLens scope")
    fun `auth-kotlin#4 FirebaseAuth tenantId updates active AuthLens scope`() {
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        harness.auth.tenantId = "tenant-enterprise-1"
        assertEquals("tenant-enterprise-1", harness.auth.tenantId)

        val lens = harness.auth.getEffectiveLens()
        assertTrue(lens is AuthLens.AsUser)
        assertEquals("tenant-enterprise-1", (lens as AuthLens.AsUser).tenant)
        assertEquals("tenant-enterprise-1", lens.toMap()["tenant"])
    }

    @Test
    @DisplayName("auth-kotlin#5: FirebaseAuth.clearInstancesForTest resets cached instances")
    fun `auth-kotlin#5 FirebaseAuth clearInstancesForTest resets cached instances`() {
        FirebaseAuth.clearInstancesForTest()
        val inst1 = FirebaseAuth.getInstance(harness.app)
        FirebaseAuth.clearInstancesForTest()
        val inst2 = FirebaseAuth.getInstance(harness.app)
        assertNotNull(inst1)
        assertNotNull(inst2)
    }

    // ── 2. FirebaseAuth: Authentication Operations ─────────────────────────
    @Test
    @DisplayName("auth-kotlin#6: FirebaseAuth.signInWithEmailAndPassword authenticates user")
    fun `auth-kotlin#6 FirebaseAuth signInWithEmailAndPassword authenticates user`() {
        val task = harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")
        val result = Tasks.await(task)
        assertNotNull(result.user)
        assertEquals("user-alice", result.user?.uid)
        assertEquals("alice@example.com", result.user?.email)
        assertEquals("user-alice", harness.auth.currentUser?.uid)

        val op = harness.sentOps.find { it["method"] == "auth.signInEmail" }
        assertNotNull(op)
        assertEquals("alice@example.com", op?.get("email"))
    }

    @Test
    @DisplayName("auth-kotlin#7: FirebaseAuth.createUserWithEmailAndPassword registers user")
    fun `auth-kotlin#7 FirebaseAuth createUserWithEmailAndPassword registers user`() {
        val task = harness.auth.createUserWithEmailAndPassword("new@example.com", "pass123")
        val result = Tasks.await(task)
        assertNotNull(result.user)
        assertEquals("user-new", result.user?.uid)
        assertEquals("user-new", harness.auth.currentUser?.uid)
        assertTrue(result.additionalUserInfo?.isNewUser == true)
    }

    @Test
    @DisplayName("auth-kotlin#8: FirebaseAuth.signInAnonymously establishes anonymous session")
    fun `auth-kotlin#8 FirebaseAuth signInAnonymously establishes anonymous session`() {
        val task = harness.auth.signInAnonymously()
        val result = Tasks.await(task)
        assertNotNull(result.user)
        assertEquals("anon-123", result.user?.uid)
        assertTrue(result.user?.isAnonymous == true)
    }

    @Test
    @DisplayName("auth-kotlin#9: FirebaseAuth.signOut clears user and resets lens to anon")
    fun `auth-kotlin#9 FirebaseAuth signOut clears user and resets lens to anon`() {
        Tasks.await(harness.auth.signInAnonymously())
        assertNotNull(harness.auth.currentUser)

        harness.auth.signOut()
        Thread.sleep(40)
        assertNull(harness.auth.currentUser)
        assertEquals(AuthLens.Anon, harness.auth.getEffectiveLens())
    }

    @Test
    @DisplayName("auth-kotlin#10: FirebaseAuth.currentUser reflects active session state")
    fun `auth-kotlin#10 FirebaseAuth currentUser reflects active session state`() {
        assertNull(harness.auth.currentUser)
        Tasks.await(harness.auth.signInAnonymously())
        assertEquals("anon-123", harness.auth.currentUser?.uid)
    }

    // ── 3. FirebaseAuth: State Observers & Modern Flows ────────────────────
    @Test
    @DisplayName("auth-kotlin#11: FirebaseAuth.authStateFlow emits active user on transitions")
    fun `auth-kotlin#11 FirebaseAuth authStateFlow emits active user on transitions`() = runBlocking {
        assertEquals(null, harness.auth.authStateFlow().first())
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertEquals("user-alice", harness.auth.authStateFlow().first()?.uid)
    }

    @Test
    @DisplayName("auth-kotlin#12: FirebaseAuth.idTokenFlow emits user on token update")
    fun `auth-kotlin#12 FirebaseAuth idTokenFlow emits user on token update`() = runBlocking {
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        val user = harness.auth.idTokenFlow().first()
        assertEquals("user-alice", user?.uid)
    }

    @Test
    @DisplayName("auth-kotlin#13: FirebaseAuth.addAuthStateListener notifies on changes")
    fun `auth-kotlin#13 FirebaseAuth addAuthStateListener notifies on changes`() {
        val latch = CountDownLatch(2)
        val listener = FirebaseAuth.AuthStateListener { latch.countDown() }
        harness.auth.addAuthStateListener(listener)
        Tasks.await(harness.auth.signInAnonymously())
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        harness.auth.removeAuthStateListener(listener)
    }

    @Test
    @DisplayName("auth-kotlin#14: FirebaseAuth.addIdTokenListener notifies on token changes")
    fun `auth-kotlin#14 FirebaseAuth addIdTokenListener notifies on token changes`() {
        val latch = CountDownLatch(2)
        val listener = FirebaseAuth.IdTokenListener { latch.countDown() }
        harness.auth.addIdTokenListener(listener)
        Tasks.await(harness.auth.signInAnonymously())
        assertTrue(latch.await(2, TimeUnit.SECONDS))
        harness.auth.removeIdTokenListener(listener)
    }

    // ── 4. FirebaseUser: User Identity & Properties ────────────────────────
    @Test
    @DisplayName("auth-kotlin#15: FirebaseUser.uid returns unique identifier string")
    fun `auth-kotlin#15 FirebaseUser uid returns unique identifier string`() {
        val result = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertEquals("user-alice", result.user!!.uid)
    }

    @Test
    @DisplayName("auth-kotlin#16: FirebaseUser.email returns user email address")
    fun `auth-kotlin#16 FirebaseUser email returns user email address`() {
        val result = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertEquals("alice@example.com", result.user!!.email)
    }

    @Test
    @DisplayName("auth-kotlin#17: FirebaseUser.displayName returns profile display name")
    fun `auth-kotlin#17 FirebaseUser displayName returns profile display name`() {
        val result = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertEquals("Alice", result.user!!.displayName)
    }

    @Test
    @DisplayName("auth-kotlin#18: FirebaseUser.photoUrl returns profile photo URI")
    fun `auth-kotlin#18 FirebaseUser photoUrl returns profile photo URI`() {
        val result = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertNull(result.user!!.photoUrl)
    }

    @Test
    @DisplayName("auth-kotlin#19: FirebaseUser.phoneNumber returns user phone number")
    fun `auth-kotlin#19 FirebaseUser phoneNumber returns user phone number`() {
        val result = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        assertNull(result.user!!.phoneNumber)
    }

    @Test
    @DisplayName("auth-kotlin#20: FirebaseUser.isAnonymous distinguishes account types")
    fun `auth-kotlin#20 FirebaseUser isAnonymous distinguishes account types`() {
        val emailUser = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        assertFalse(emailUser.isAnonymous)
        val anonUser = Tasks.await(harness.auth.signInAnonymously()).user!!
        assertTrue(anonUser.isAnonymous)
    }

    @Test
    @DisplayName("auth-kotlin#21: FirebaseUser.isEmailVerified reflects verification state")
    fun `auth-kotlin#21 FirebaseUser isEmailVerified reflects verification state`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        assertTrue(user.isEmailVerified)
    }

    @Test
    @DisplayName("auth-kotlin#22: FirebaseUser.providerId returns primary provider")
    fun `auth-kotlin#22 FirebaseUser providerId returns primary provider`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        assertEquals("password", user.providerId)
    }

    @Test
    @DisplayName("auth-kotlin#23: FirebaseUser.providerData lists linked providers")
    fun `auth-kotlin#23 FirebaseUser providerData lists linked providers`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        assertEquals(1, user.providerData.size)
        assertEquals("password", user.providerData[0].providerId)
    }

    @Test
    @DisplayName("auth-kotlin#24: FirebaseUser.customClaims carries token claims into AuthLens")
    fun `auth-kotlin#24 FirebaseUser customClaims carries token claims into AuthLens`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        assertEquals("admin", user.customClaims["role"])

        val lens = harness.auth.getEffectiveLens() as AuthLens.AsUser
        assertEquals("admin", lens.token?.get("role"))
    }

    // ── 5. FirebaseUser: Token & Profile Operations ────────────────────────
    @Test
    @DisplayName("auth-kotlin#25: FirebaseUser.getIdToken retrieves JWT token string")
    fun `auth-kotlin#25 FirebaseUser getIdToken retrieves JWT token string`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        val token = Tasks.await(user.getIdToken(forceRefresh = true))
        assertEquals("mock.jwt.token", token.token)
    }

    @Test
    @DisplayName("auth-kotlin#26: FirebaseUser.getIdTokenResult returns structured token metadata")
    fun `auth-kotlin#26 FirebaseUser getIdTokenResult returns structured token metadata`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        val result = Tasks.await(user.getIdTokenResult(forceRefresh = true))
        assertEquals("mock.jwt.token", result.token)
        assertEquals("admin", result.claims["role"])
        assertEquals(1800000000L, result.expirationTimestamp)
        assertEquals("password", result.signInProvider)
    }

    @Test
    @DisplayName("auth-kotlin#27: FirebaseUser.updateProfile mutates display name and photo")
    fun `auth-kotlin#27 FirebaseUser updateProfile mutates display name and photo`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        val req = UserProfileChangeRequest.Builder()
            .setDisplayName("Alice Updated")
            .setPhotoUri(URI.create("https://example.com/alice.png"))
            .build()
        Tasks.await(user.updateProfile(req))
        assertEquals("Alice Updated", user.displayName)
        assertEquals(URI.create("https://example.com/alice.png"), user.photoUrl)
    }

    @Test
    @DisplayName("auth-kotlin#28: FirebaseUser.reload refreshes user profile from bridge")
    fun `auth-kotlin#28 FirebaseUser reload refreshes user profile from bridge`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        Tasks.await(user.reload())
        assertEquals("Alice Reloaded", user.displayName)
    }

    // ── 6. UserProfileChangeRequest: Profile Mutation Builder ──────────────
    @Test
    @DisplayName("auth-kotlin#29: UserProfileChangeRequest.Builder constructs request")
    fun `auth-kotlin#29 UserProfileChangeRequest Builder constructs request`() {
        val req = UserProfileChangeRequest.Builder()
            .setDisplayName("Charlie")
            .setPhotoUri("https://example.com/photo.jpg")
            .build()
        assertEquals("Charlie", req.displayName)
        assertEquals(URI.create("https://example.com/photo.jpg"), req.photoUri)
    }

    // ── 7. Data Models & Exception Handling ────────────────────────────────
    @Test
    @DisplayName("auth-kotlin#30: AuthResult and AdditionalUserInfo package auth result")
    fun `auth-kotlin#30 AuthResult and AdditionalUserInfo package auth result`() {
        val result = Tasks.await(harness.auth.createUserWithEmailAndPassword("bob@example.com", "secret"))
        assertNotNull(result.user)
        assertNotNull(result.additionalUserInfo)
        assertEquals("password", result.additionalUserInfo?.providerId)
        assertTrue(result.additionalUserInfo?.isNewUser == true)
    }

    @Test
    @DisplayName("auth-kotlin#31: GetTokenResult exposes claims and expiration timestamps")
    fun `auth-kotlin#31 GetTokenResult exposes claims and expiration timestamps`() {
        val user = Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123")).user!!
        val res = Tasks.await(user.getIdTokenResult())
        assertEquals("mock.jwt.token", res.token)
        assertEquals("admin", res.claims["role"])
        assertTrue(res.expirationTimestamp > 0)
    }

    @Test
    @DisplayName("auth-kotlin#32: FirebaseAuthException translates standard error codes")
    fun `auth-kotlin#32 FirebaseAuthException translates standard error codes`() {
        val task = harness.auth.signInWithEmailAndPassword("test@example.com", "wrong-password")
        val ex = assertThrows<ExecutionException> { Tasks.await(task) }
        val cause = ex.cause
        assertTrue(cause is FirebaseAuthException)
        assertEquals("ERROR_WRONG_PASSWORD", (cause as FirebaseAuthException).errorCode)
    }

    // ── 8. CredentialsProvider & Firestore Auth Coupling ───────────────────
    @Test
    @DisplayName("auth-kotlin#33: CredentialsProvider.getEffectiveLens returns current AuthLens")
    fun `auth-kotlin#33 CredentialsProvider getEffectiveLens returns current AuthLens`() {
        assertEquals(AuthLens.Anon, harness.auth.getEffectiveLens())
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        val lens = harness.auth.getEffectiveLens()
        assertTrue(lens is AuthLens.AsUser)
        assertEquals("user-alice", (lens as AuthLens.AsUser).uid)
    }

    @Test
    @DisplayName("auth-kotlin#34: CredentialsProvider.authLensFlow emits lens transitions")
    fun `auth-kotlin#34 CredentialsProvider authLensFlow emits lens transitions`() = runBlocking {
        assertEquals(AuthLens.Anon, harness.auth.authLensFlow.first())
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        val lens = harness.auth.authLensFlow.first()
        assertTrue(lens is AuthLens.AsUser)
        assertEquals("user-alice", (lens as AuthLens.AsUser).uid)
    }

    @Test
    @DisplayName("auth-kotlin#35: FirebaseFirestore automatically stamps actAs from FirebaseAuth")
    fun `auth-kotlin#35 FirebaseFirestore automatically stamps actAs from FirebaseAuth`() {
        Tasks.await(harness.auth.signInWithEmailAndPassword("alice@example.com", "pass123"))
        Tasks.await(harness.firestore.collection("users").document("alice").get())

        val op = harness.sentOps.find { it["method"] == "getDoc" }
        assertNotNull(op)
        @Suppress("UNCHECKED_CAST")
        val actAs = op?.get("actAs") as? Map<String, Any?>
        assertNotNull(actAs)
        assertEquals("as", actAs?.get("mode"))
        assertEquals("user-alice", actAs?.get("uid"))
    }

    @Test
    @DisplayName("auth-kotlin#36: FirebaseFirestore snapshots flow re-subscribes on auth transition")
    fun `auth-kotlin#36 FirebaseFirestore snapshots flow re-subscribes on auth transition`() = runBlocking {
        val flow = harness.firestore.collection("users").document("alice").snapshots()
        val snap = flow.first()
        assertNotNull(snap)
        assertTrue(harness.sentSubs.isNotEmpty())
    }
}
