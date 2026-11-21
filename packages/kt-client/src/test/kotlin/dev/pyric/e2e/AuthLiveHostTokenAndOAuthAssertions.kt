package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
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
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

internal const val AUTH_LIVE_PROJECT_ID = "demo-kotlin-live"

internal fun newAuthLiveApp(prefix: String): FirebaseApp {
    return FirebaseApp.initializeApp(
        "$prefix-${System.nanoTime()}",
        FirebaseOptions.Builder()
            .setProjectId(AUTH_LIVE_PROJECT_ID)
            .setApiKey("demo-live-api-key")
            .setApplicationId("dev.pyric.live.auth")
            .setDatabaseUrl("https://$AUTH_LIVE_PROJECT_ID-default-rtdb.firebaseio.com")
            .build()
    )
}

internal fun awaitAuthCondition(timeoutMs: Long = 5_000L, predicate: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        if (predicate()) return
        Thread.sleep(15)
    }
    assertTrue(predicate(), "Timed out waiting for condition after ${timeoutMs}ms")
}

internal fun expectLiveAuthException(block: () -> Unit): FirebaseAuthException {
    try {
        block()
        throw AssertionError("Expected FirebaseAuthException failure, but operation succeeded")
    } catch (err: ExecutionException) {
        val cause = err.cause ?: err
        assertTrue(
            cause is FirebaseAuthException,
            "Expected FirebaseAuthException, got ${cause.javaClass.name}: ${cause.message}"
        )
        return cause as FirebaseAuthException
    }
}

internal fun assertLiveFirestoreDenied(block: () -> Unit) {
    try {
        block()
        throw AssertionError("Expected Firestore PERMISSION_DENIED, but operation succeeded")
    } catch (err: ExecutionException) {
        val cause = err.cause ?: err
        assertTrue(
            cause is FirebaseFirestoreException,
            "Expected FirebaseFirestoreException, got ${cause.javaClass.name}: ${cause.message}"
        )
        assertEquals(
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            (cause as FirebaseFirestoreException).code
        )
    }
}

internal fun runTokenAndProfileLiveHostAssertions() {
    val appA = newAuthLiveApp("kotlin-token-profile-a")
    val appB = newAuthLiveApp("kotlin-token-profile-b")
    val authA = FirebaseAuth.getInstance(appA)
    val authB = FirebaseAuth.getInstance(appB)

    val email = "token-profile-${System.nanoTime()}@example.com"
    val pass = "TokenProfile!123"
    val created = Tasks.await(authA.createUserWithEmailAndPassword(email, pass), 10, TimeUnit.SECONDS)
    val userA = requireNotNull(created.user)

    // auth-kotlin#25: getIdToken(false) and forced refresh getIdToken(true)
    val initialToken = Tasks.await(userA.getIdToken(false), 10, TimeUnit.SECONDS)
    assertTrue(initialToken.token.count { it == '.' } == 2)
    val refreshedToken = Tasks.await(userA.getIdToken(true), 10, TimeUnit.SECONDS)
    assertTrue(refreshedToken.token.count { it == '.' } == 2)
    assertNotEquals(initialToken.token, refreshedToken.token)

    // auth-kotlin#26: getIdTokenResult(forceRefresh) structured metadata
    val structured = Tasks.await(userA.getIdTokenResult(false), 10, TimeUnit.SECONDS)
    assertEquals(refreshedToken.token, structured.token)
    assertEquals(userA.uid, structured.claims["sub"])
    assertEquals(email, structured.claims["email"])
    assertEquals("password", structured.signInProvider)
    assertTrue(structured.issuedAtTimestamp > 0L)
    assertTrue(structured.authTimestamp > 0L)
    assertTrue(structured.expirationTimestamp > structured.issuedAtTimestamp)

    // auth-kotlin#29: UserProfileChangeRequest.Builder (URI and String overloads)
    val uriOverload = UserProfileChangeRequest.Builder()
        .setDisplayName("Casey Initial")
        .setPhotoUri(URI.create("https://example.com/photos/casey-v1.png"))
        .build()
    assertEquals("Casey Initial", uriOverload.displayName)
    assertEquals(URI.create("https://example.com/photos/casey-v1.png"), uriOverload.photoUri)

    val stringOverload = UserProfileChangeRequest.Builder()
        .setDisplayName("Casey Remote")
        .setPhotoUri("https://example.com/photos/casey-v2.png")
        .build()
    assertEquals("Casey Remote", stringOverload.displayName)
    assertEquals(URI.create("https://example.com/photos/casey-v2.png"), stringOverload.photoUri)

    // auth-kotlin#27: updateProfile mutates host state and notifies IdTokenListener without firing AuthStateListener
    val authStateNotifications = CopyOnWriteArrayList<String?>()
    val idTokenNotifications = CopyOnWriteArrayList<String?>()
    val authProfileListener = FirebaseAuth.AuthStateListener { a ->
        authStateNotifications.add(a.currentUser?.uid)
    }
    val tokenProfileListener = FirebaseAuth.IdTokenListener { a ->
        idTokenNotifications.add(a.currentUser?.displayName)
    }
    authA.addAuthStateListener(authProfileListener)
    authA.addIdTokenListener(tokenProfileListener)
    val initialAuthStateCount = authStateNotifications.size
    try {
        Tasks.await(userA.updateProfile(uriOverload), 10, TimeUnit.SECONDS)
        assertEquals("Casey Initial", userA.displayName)
        assertEquals(URI.create("https://example.com/photos/casey-v1.png"), userA.photoUrl)
        assertTrue(idTokenNotifications.contains("Casey Initial"))
        assertEquals(initialAuthStateCount, authStateNotifications.size)

        // Partial update preserves untouched photoUrl; explicit null clears photoUrl
        val partialNameOnly = UserProfileChangeRequest.Builder()
            .setDisplayName("Casey Partial")
            .build()
        Tasks.await(userA.updateProfile(partialNameOnly), 10, TimeUnit.SECONDS)
        assertEquals("Casey Partial", userA.displayName)
        assertEquals(URI.create("https://example.com/photos/casey-v1.png"), userA.photoUrl)

        val clearPhotoReq = UserProfileChangeRequest.Builder()
            .setPhotoUri(null as URI?)
            .build()
        Tasks.await(userA.updateProfile(clearPhotoReq), 10, TimeUnit.SECONDS)
        assertEquals("Casey Partial", userA.displayName)
        assertNull(userA.photoUrl)
        assertEquals(initialAuthStateCount, authStateNotifications.size)
    } finally {
        authA.removeAuthStateListener(authProfileListener)
        authA.removeIdTokenListener(tokenProfileListener)
    }

    // auth-kotlin#28: reload() observes out-of-band profile update from second live session
    val userB = requireNotNull(
        Tasks.await(authB.signInWithEmailAndPassword(email, pass), 10, TimeUnit.SECONDS).user
    )
    assertEquals("Casey Partial", userB.displayName)
    assertNull(userB.photoUrl)
    Tasks.await(userB.updateProfile(stringOverload), 10, TimeUnit.SECONDS)
    assertEquals("Casey Partial", userA.displayName)

    Tasks.await(userA.reload(), 10, TimeUnit.SECONDS)
    assertEquals("Casey Remote", userA.displayName)
    assertEquals(URI.create("https://example.com/photos/casey-v2.png"), userA.photoUrl)

    // When userB deletes the account on the live host, userA.reload() surfaces
    // FirebaseAuthInvalidUserException(ERROR_USER_TOKEN_EXPIRED) and clears authA.currentUser
    Tasks.await(userB.delete(), 10, TimeUnit.SECONDS)
    assertNull(authB.currentUser)

    val expiredCause = expectLiveAuthException {
        Tasks.await(userA.reload(), 10, TimeUnit.SECONDS)
    }
    assertTrue(expiredCause is FirebaseAuthInvalidUserException)
    assertEquals("ERROR_USER_TOKEN_EXPIRED", expiredCause.errorCode)
    assertNull(authA.currentUser)
}

internal fun runModelsAndExceptionsLiveHostAssertions() {
    val app = newAuthLiveApp("kotlin-models-exceptions")
    val auth = FirebaseAuth.getInstance(app)

    val email = "models-${System.nanoTime()}@example.com"
    val pass = "ModelsPass!123"

    // auth-kotlin#30: create vs signIn vs anonymous vs federated AdditionalUserInfo
    val createRes = Tasks.await(auth.createUserWithEmailAndPassword(email, pass), 10, TimeUnit.SECONDS)
    assertNotNull(createRes.user)
    assertEquals("password", createRes.additionalUserInfo?.providerId)
    assertEquals(true, createRes.additionalUserInfo?.isNewUser)

    auth.signOut()
    val signInRes = Tasks.await(auth.signInWithEmailAndPassword(email, pass), 10, TimeUnit.SECONDS)
    assertEquals(createRes.user?.uid, signInRes.user?.uid)
    assertEquals("password", signInRes.additionalUserInfo?.providerId)
    assertEquals(false, signInRes.additionalUserInfo?.isNewUser)

    auth.signOut()
    val firstAnon = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
    assertNull(firstAnon.additionalUserInfo?.providerId)
    assertEquals(true, firstAnon.additionalUserInfo?.isNewUser)
    val repeatAnon = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
    assertEquals(firstAnon.user?.uid, repeatAnon.user?.uid)
    assertEquals(false, repeatAnon.additionalUserInfo?.isNewUser)

    auth.signOut()
    val oauthUid = "oauth-models-${System.nanoTime()}"
    Tasks.await(
        auth.stageSignInResult(
            providerId = GoogleAuthProvider.PROVIDER_ID,
            uid = oauthUid,
            email = "oauth-$oauthUid@example.com",
            displayName = "OAuth Models",
            emailVerified = true,
            customClaims = mapOf("tier" to "enterprise")
        ),
        10,
        TimeUnit.SECONDS
    )
    val firstOauth = Tasks.await(
        auth.signInWithCredential(GoogleAuthProvider.getCredential("g-id-1", "g-acc-1")),
        10,
        TimeUnit.SECONDS
    )
    assertEquals("google.com", firstOauth.additionalUserInfo?.providerId)
    assertEquals(true, firstOauth.additionalUserInfo?.isNewUser)

    // auth-kotlin#31: GetTokenResult encapsulates token, claims, timestamps, and signInProvider
    val oauthUser = requireNotNull(firstOauth.user)
    val tokenResult = Tasks.await(oauthUser.getIdTokenResult(true), 10, TimeUnit.SECONDS)
    assertTrue(tokenResult.token.isNotBlank())
    assertEquals("enterprise", tokenResult.claims["tier"])
    assertEquals("google.com", tokenResult.signInProvider)
    assertTrue(tokenResult.issuedAtTimestamp > 0L)
    assertTrue(tokenResult.authTimestamp > 0L)
    assertTrue(tokenResult.expirationTimestamp >= tokenResult.issuedAtTimestamp + 3000L)

    // Second sign-in with the same staged OAuth uid marks isNewUser = false
    auth.signOut()
    Tasks.await(
        auth.stageSignInResult(
            providerId = GoogleAuthProvider.PROVIDER_ID,
            uid = oauthUid,
            email = "oauth-$oauthUid@example.com"
        ),
        10,
        TimeUnit.SECONDS
    )
    val secondOauth = Tasks.await(
        auth.signInWithCredential(GoogleAuthProvider.getCredential("g-id-2", null)),
        10,
        TimeUnit.SECONDS
    )
    assertEquals(oauthUid, secondOauth.user?.uid)
    assertEquals("google.com", secondOauth.additionalUserInfo?.providerId)
    assertEquals(false, secondOauth.additionalUserInfo?.isNewUser)

    // auth-kotlin#32: FirebaseAuthException error codes and Android SDK subclasses on live host
    auth.signOut()
    val invalidEmailEx = expectLiveAuthException {
        Tasks.await(auth.createUserWithEmailAndPassword("not-an-email", pass), 10, TimeUnit.SECONDS)
    }
    assertTrue(invalidEmailEx is FirebaseAuthInvalidCredentialsException)
    assertEquals("ERROR_INVALID_EMAIL", invalidEmailEx.errorCode)

    val weakPassEx = expectLiveAuthException {
        Tasks.await(auth.createUserWithEmailAndPassword("weak-${System.nanoTime()}@example.com", "123"), 10, TimeUnit.SECONDS)
    }
    assertTrue(weakPassEx is FirebaseAuthWeakPasswordException)
    assertEquals("ERROR_WEAK_PASSWORD", weakPassEx.errorCode)

    val collisionEx = expectLiveAuthException {
        Tasks.await(auth.createUserWithEmailAndPassword(email, pass), 10, TimeUnit.SECONDS)
    }
    assertTrue(collisionEx is FirebaseAuthUserCollisionException)
    assertEquals("ERROR_EMAIL_ALREADY_IN_USE", collisionEx.errorCode)

    val wrongPassEx = expectLiveAuthException {
        Tasks.await(auth.signInWithEmailAndPassword(email, "WrongPass!999"), 10, TimeUnit.SECONDS)
    }
    assertTrue(wrongPassEx is FirebaseAuthInvalidCredentialsException)
    assertEquals("ERROR_INVALID_CREDENTIAL", wrongPassEx.errorCode)

    val unknownEmailEx = expectLiveAuthException {
        Tasks.await(
            auth.signInWithEmailAndPassword("missing-${System.nanoTime()}@example.com", pass),
            10,
            TimeUnit.SECONDS
        )
    }
    assertTrue(unknownEmailEx is FirebaseAuthInvalidCredentialsException)
    assertEquals("ERROR_INVALID_CREDENTIAL", unknownEmailEx.errorCode)
}

internal fun runCredentialsAndOAuthLiveHostAssertions() = runBlocking {
    val app = newAuthLiveApp("kotlin-creds-oauth")
    val auth = FirebaseAuth.getInstance(app)
    val firestore = FirebaseFirestore.getInstance(app)
    val collectorScope = CoroutineScope(Dispatchers.IO)

    val observedLenses = CopyOnWriteArrayList<AuthLens>()
    val lensJob = collectorScope.launch {
        auth.authLensFlow.collect { lens -> observedLenses.add(lens) }
    }

    val lobbyRoomId = "lobby-${System.nanoTime()}"
    val roomDoc = firestore.document("rooms/$lobbyRoomId")
    val roomSnapshots = CopyOnWriteArrayList<Pair<Boolean, Any?>>()
    val roomErrors = CopyOnWriteArrayList<Throwable>()

    // auth-kotlin#36: Start collecting snapshots() while signed out (AuthLens.Anon allowed on rooms/{id})
    val roomSnapJob = collectorScope.launch {
        roomDoc.snapshots()
            .catch { e -> roomErrors.add(e) }
            .collect { snap -> roomSnapshots.add(snap.exists() to snap.get("topic")) }
    }

    try {
        // auth-kotlin#33 & #34: Initial signed-out lens is AuthLens.Anon
        assertEquals(AuthLens.Anon, auth.getEffectiveLens())
        awaitAuthCondition { observedLenses.contains(AuthLens.Anon) && roomSnapshots.isNotEmpty() }
        assertEquals(false to null, roomSnapshots.first())

        // auth-kotlin#37: GoogleAuthProvider.getCredential
        val googleCred = GoogleAuthProvider.getCredential("google-id-token-37", "google-access-token-37")
        assertEquals("google.com", googleCred.provider)
        val googleWire = googleCred.toWireMap()
        assertEquals("google.com", googleWire["providerId"])
        assertEquals("google-id-token-37", googleWire["idToken"])
        assertEquals("google-access-token-37", googleWire["accessToken"])

        // auth-kotlin#38: OAuthProvider.getCredential (github.com + rawNonce, and apple.com)
        val githubCred = OAuthProvider.getCredential(
            "github.com",
            "gh-id-token-38",
            "gh-access-token-38",
            "raw-nonce-xyz"
        )
        assertTrue(githubCred is OAuthCredential)
        val ghTyped = githubCred as OAuthCredential
        assertEquals("github.com", ghTyped.provider)
        assertEquals("gh-id-token-38", ghTyped.idToken)
        assertEquals("gh-access-token-38", ghTyped.accessToken)
        assertEquals("raw-nonce-xyz", ghTyped.rawNonce)

        val appleCred = OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("apple-id-token-38", "apple-raw-nonce")
            .setAccessToken("apple-access-token-38")
            .build()
        assertEquals("apple.com", appleCred.provider)
        assertEquals("apple-raw-nonce", (appleCred as OAuthCredential).rawNonce)

        // auth-kotlin#39: Sign in with GitHub OAuth credential carrying role = "member" and tenant = "tenant-beta"
        auth.tenantId = "tenant-beta"
        val githubUid = "gh-uid-${System.nanoTime()}"
        Tasks.await(
            auth.stageSignInResult(
                providerId = "github.com",
                uid = githubUid,
                email = "octocat@example.com",
                displayName = "Octocat",
                emailVerified = true,
                customClaims = mapOf("role" to "member")
            ),
            10,
            TimeUnit.SECONDS
        )
        val ghSignIn = Tasks.await(auth.signInWithCredential(githubCred), 10, TimeUnit.SECONDS)
        val ghUser = requireNotNull(ghSignIn.user)
        assertEquals(githubUid, ghUser.uid)
        assertEquals("tenant-beta", ghUser.tenantId)
        assertEquals(listOf("firebase", "github.com"), ghUser.providerData.map { it.providerId })

        // auth-kotlin#33 & #34: Effective lens and authLensFlow updated with uid, tenant, and claims
        val signedInLens = auth.getEffectiveLens()
        assertTrue(signedInLens is AuthLens.AsUser)
        val asGhUser = signedInLens as AuthLens.AsUser
        assertEquals(githubUid, asGhUser.uid)
        assertEquals("tenant-beta", asGhUser.tenant)
        assertEquals("member", asGhUser.token?.get("role"))
        awaitAuthCondition {
            observedLenses.any { it is AuthLens.AsUser && it.uid == githubUid && it.tenant == "tenant-beta" }
        }

        // auth-kotlin#35: Firestore operations automatically stamp AuthLens.AsUser across rules
        Tasks.await(
            firestore.document("provider_profiles/github.com/users/$githubUid")
                .set(mapOf("handle" to "octocat")),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            firestore.document("tenant_rooms/tenant-beta/rooms/r-1")
                .set(mapOf("name" to "Beta Lounge", "open" to true)),
            10,
            TimeUnit.SECONDS
        )
        val tenantQuery = Tasks.await(
            firestore.collection("tenant_rooms/tenant-beta/rooms")
                .whereEqualTo("open", true)
                .get(),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(1, tenantQuery.size())

        // auth-kotlin#36: Active roomDoc.snapshots() flow automatically re-subscribed as role == "member"
        Tasks.await(
            roomDoc.set(mapOf("topic" to "live-resubscribed")),
            10,
            TimeUnit.SECONDS
        )
        awaitAuthCondition {
            roomSnapshots.any { it.first && it.second == "live-resubscribed" }
        }
        assertTrue(roomErrors.isEmpty())

        // Also verify Apple OAuth signInWithCredential (#38 & #39)
        auth.tenantId = null
        val appleUid = "apple-uid-${System.nanoTime()}"
        Tasks.await(
            auth.stageSignInResult(
                providerId = "apple.com",
                uid = appleUid,
                email = "apple@example.com",
                emailVerified = true
            ),
            10,
            TimeUnit.SECONDS
        )
        val appleSignIn = Tasks.await(auth.signInWithCredential(appleCred), 10, TimeUnit.SECONDS)
        assertEquals(appleUid, appleSignIn.user?.uid)
        assertEquals("apple.com", appleSignIn.additionalUserInfo?.providerId)
        Tasks.await(
            firestore.document("provider_profiles/apple.com/users/$appleUid")
                .set(mapOf("device" to "mobile")),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            firestore.document("users/$appleUid").set(mapOf("status" to "active")),
            10,
            TimeUnit.SECONDS
        )

        // Verify snapshots() on owner-only users/{uid} revokes with PERMISSION_DENIED upon signOut()
        val privateSnaps = CopyOnWriteArrayList<Any?>()
        val privateErrors = CopyOnWriteArrayList<Throwable>()
        val privateJob = collectorScope.launch {
            firestore.document("users/$appleUid").snapshots()
                .catch { e -> privateErrors.add(e) }
                .collect { snap -> privateSnaps.add(snap.get("status")) }
        }
        try {
            awaitAuthCondition { privateSnaps.contains("active") }
            auth.signOut()
            assertEquals(AuthLens.Anon, auth.getEffectiveLens())
            awaitAuthCondition { observedLenses.lastOrNull() == AuthLens.Anon }
            awaitAuthCondition { privateErrors.isNotEmpty() }
            val err = privateErrors.first()
            assertTrue(err is FirebaseFirestoreException)
            assertEquals(
                FirebaseFirestoreException.Code.PERMISSION_DENIED,
                (err as FirebaseFirestoreException).code
            )
        } finally {
            privateJob.cancel()
        }
    } finally {
        roomSnapJob.cancel()
        lensJob.cancel()
        collectorScope.cancel()
    }
}
