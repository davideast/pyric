package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.GoogleAuthCredential
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthCredential
import com.google.firebase.auth.OAuthProvider
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.database.FirebaseDatabase
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class AuthCredentialsOracleParityLiveHostConformanceTest {

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping live-host Auth credentials parity test"
        )
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("auth-kotlin Wave 4 parity: languageCode, anonymous linkWithCredential, collision, reauthenticate, updatePassword, and unlink")
    fun `proves Android 35_2_0 linking, collision, reauth, password update, and unlink parity on live host`() {
        val app = newAuthLiveApp("auth-wave4-linking")
        val auth = FirebaseAuth.getInstance(app)

        assertNull(auth.languageCode)
        auth.setLanguageCode("de")
        assertEquals("de", auth.languageCode)
        auth.useAppLanguage()
        assertTrue(auth.languageCode == null || auth.languageCode.orEmpty().isNotBlank())

        val suffix = System.nanoTime()
        val upgradeEmail = "kt-link-$suffix@example.com"
        val collisionEmail = "kt-collision-$suffix@example.com"
        val initialPassword = "InitialLink!$suffix"
        val updatedPassword = "UpdatedLink!$suffix"

        val anonResult = Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS)
        val anonUser = requireNotNull(anonResult.user)
        val originalUid = anonUser.uid
        assertNull(anonUser.phoneNumber)
        assertEquals(listOf("firebase"), anonUser.providerData.map { it.providerId })
        assertEquals(originalUid, anonUser.providerData.first().uid)

        val linkCred = EmailAuthProvider.getCredential(upgradeEmail, initialPassword)
        assertEquals("password", linkCred.provider)
        assertEquals("password", linkCred.signInMethod)

        val linkedResult = Tasks.await(anonUser.linkWithCredential(linkCred), 10, TimeUnit.SECONDS)
        val linkedUser = requireNotNull(linkedResult.user)
        assertEquals(originalUid, linkedUser.uid)
        assertFalse(linkedUser.isAnonymous)
        assertEquals(upgradeEmail, linkedUser.email)
        assertNull(linkedUser.phoneNumber)
        assertEquals(listOf("firebase", "password"), linkedUser.providerData.map { it.providerId })
        assertEquals(originalUid, linkedUser.providerData[0].uid)
        assertNotEquals(originalUid, linkedUser.providerData[1].uid)
        assertEquals(upgradeEmail, linkedUser.providerData[1].email)

        auth.signOut()
        Tasks.await(
            auth.createUserWithEmailAndPassword(collisionEmail, initialPassword),
            10,
            TimeUnit.SECONDS
        )
        auth.signOut()

        val collisionAnon = requireNotNull(
            Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user
        )
        val collisionEx = expectLiveAuthException {
            Tasks.await(
                collisionAnon.linkWithCredential(
                    EmailAuthProvider.getCredential(collisionEmail, initialPassword)
                ),
                10,
                TimeUnit.SECONDS
            )
        }
        assertTrue(collisionEx is FirebaseAuthUserCollisionException)
        assertEquals("ERROR_EMAIL_ALREADY_IN_USE", collisionEx.errorCode)
        auth.signOut()

        val relogin = Tasks.await(
            auth.signInWithEmailAndPassword(upgradeEmail, initialPassword),
            10,
            TimeUnit.SECONDS
        )
        val activeLinkedUser = requireNotNull(relogin.user)
        assertEquals(originalUid, activeLinkedUser.uid)

        val alreadyLinkedExec = assertThrows(ExecutionException::class.java) {
            Tasks.await(
                activeLinkedUser.linkWithCredential(
                    EmailAuthProvider.getCredential(collisionEmail, initialPassword)
                ),
                10,
                TimeUnit.SECONDS
            )
        }
        val alreadyLinkedCause = alreadyLinkedExec.cause
        assertTrue(alreadyLinkedCause is FirebaseException)
        assertFalse(alreadyLinkedCause is FirebaseAuthException)
        assertEquals(
            "User has already been linked to the given provider.",
            alreadyLinkedCause?.message
        )

        val reauthResult = Tasks.await(
            activeLinkedUser.reauthenticateAndRetrieveData(
                EmailAuthProvider.getCredential(upgradeEmail, initialPassword)
            ),
            10,
            TimeUnit.SECONDS
        )
        assertEquals(originalUid, reauthResult.user?.uid)

        Tasks.await(activeLinkedUser.updatePassword(updatedPassword), 10, TimeUnit.SECONDS)
        auth.signOut()

        val updatedCred = EmailAuthProvider.getCredential(upgradeEmail, updatedPassword)
        val updatedSignIn = Tasks.await(auth.signInWithCredential(updatedCred), 10, TimeUnit.SECONDS)
        val updatedUser = requireNotNull(updatedSignIn.user)
        assertEquals(originalUid, updatedUser.uid)

        val unlinkResult = Tasks.await(
            updatedUser.unlink(EmailAuthProvider.PROVIDER_ID),
            10,
            TimeUnit.SECONDS
        )
        val unlinkedUser = requireNotNull(unlinkResult.user)
        assertEquals(listOf("firebase"), unlinkedUser.providerData.map { it.providerId })
    }

    @Test
    @DisplayName("auth-kotlin#37..39 parity: GoogleAuthCredential, OAuthCredential builders, synthetic ERROR_INVALID_CREDENTIAL, staged OAuth, and OIDC JWT fallback")
    fun `proves GoogleAuthCredential, OAuthCredential, synthetic credential rejection, and OIDC JWT sign-in on live host`() {
        val app = newAuthLiveApp("auth-wave4-oauth-parity")
        val auth = FirebaseAuth.getInstance(app)

        val googleCred = GoogleAuthProvider.getCredential(
            "synthetic-google-id-token",
            "synthetic-google-access-token"
        )
        assertTrue(googleCred is GoogleAuthCredential)
        assertFalse(googleCred is OAuthCredential)
        assertEquals("google.com", googleCred.provider)
        assertEquals("google.com", googleCred.signInMethod)

        val githubCred = OAuthProvider.getCredential(
            "github.com",
            "synthetic-github-id-token",
            "synthetic-github-access-token"
        ) as OAuthCredential
        assertEquals("github.com", githubCred.provider)
        assertEquals("github.com", githubCred.signInMethod)
        assertNotNull(githubCred.idToken)
        assertNotNull(githubCred.accessToken)

        val appleBuilder = OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("synthetic-apple-id-token", "raw-nonce-wave4")
            .setAccessToken("synthetic-apple-access-token")
        assertEquals("synthetic-apple-id-token", appleBuilder.idToken)
        assertEquals("synthetic-apple-access-token", appleBuilder.accessToken)
        val appleCred = appleBuilder.build() as OAuthCredential
        assertEquals("apple.com", appleCred.provider)
        assertEquals("apple.com", appleCred.signInMethod)

        // Un-staged synthetic non-JWT Google credential rejects with ERROR_INVALID_CREDENTIAL
        val syntheticErr = expectLiveAuthException {
            Tasks.await(auth.signInWithCredential(googleCred), 10, TimeUnit.SECONDS)
        }
        assertTrue(syntheticErr is FirebaseAuthInvalidCredentialsException)
        assertEquals("ERROR_INVALID_CREDENTIAL", syntheticErr.errorCode)

        // Un-staged well-formed 3-segment OIDC JWT succeeds via host OIDC JWT decode fallback
        val suffix = System.nanoTime()
        val oidcSub = "google-oidc-sub-$suffix"
        val oidcEmail = "oidc-$suffix@example.com"
        val headerB64 = base64Url("""{"alg":"none","typ":"JWT"}""")
        val payloadB64 = base64Url("""{"sub":"$oidcSub","email":"$oidcEmail","email_verified":true,"name":"OIDC User"}""")
        val oidcJwt = "$headerB64.$payloadB64.sig"
        val oidcResult = Tasks.await(
            auth.signInWithCredential(GoogleAuthProvider.getCredential(oidcJwt, null)),
            10,
            TimeUnit.SECONDS
        )
        val oidcUser = requireNotNull(oidcResult.user)
        assertEquals(oidcEmail, oidcUser.email)
        assertEquals(listOf("firebase", "google.com"), oidcUser.providerData.map { it.providerId })
    }

    private fun base64Url(json: String): String {
        return Base64.getUrlEncoder()
            .withoutPadding()
            .encodeToString(json.toByteArray(StandardCharsets.UTF_8))
    }
}
