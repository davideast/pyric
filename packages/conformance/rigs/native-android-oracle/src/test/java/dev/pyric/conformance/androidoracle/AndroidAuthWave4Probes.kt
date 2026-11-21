package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthCredential
import com.google.firebase.auth.OAuthProvider
import com.google.firebase.auth.auth
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame

internal fun verifyLocalRobolectricAuthWave4Smoke(context: Context) {
    val options = FirebaseOptions.Builder()
        .setProjectId("demo-robolectric-oracle")
        .setApplicationId("1:123456789000:android:abcdef012345")
        .setApiKey("AIzaSyDemoRobolectricSmokeKey00000000000")
        .build()

    val createdDefaultApp = FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }
    val defaultApp = if (createdDefaultApp) {
        FirebaseApp.initializeApp(context, options)
    } else {
        FirebaseApp.getInstance()
    }
    val namedApp = FirebaseApp.initializeApp(
        context,
        options,
        "pyric-robolectric-auth-wave4-${System.nanoTime()}"
    )
    try {
        assertSame(FirebaseAuth.getInstance(), Firebase.auth)
        assertEquals(FirebaseApp.DEFAULT_APP_NAME, Firebase.auth.app.name)

        val namedAuth = Firebase.auth(namedApp)
        assertSame(FirebaseAuth.getInstance(namedApp), namedAuth)
        assertSame(namedApp, namedAuth.app)
        assertNull(namedAuth.tenantId)
        namedAuth.setTenantId("tenant-smoke")
        assertEquals("tenant-smoke", namedAuth.tenantId)

        namedAuth.setLanguageCode("es")
        assertEquals("es", namedAuth.languageCode)
        namedAuth.useAppLanguage()

        val googleCred = GoogleAuthProvider.getCredential("synthetic-gid", "synthetic-gaccess")
        assertEquals("google.com", googleCred.provider)
        assertEquals("google.com", googleCred.signInMethod)

        @Suppress("DEPRECATION")
        val githubCred = OAuthProvider.getCredential(
            "github.com",
            "synthetic-gh-id",
            "synthetic-gh-access"
        ) as OAuthCredential
        assertEquals("github.com", githubCred.provider)
        assertEquals("synthetic-gh-id", githubCred.idToken)
        assertEquals("synthetic-gh-access", githubCred.accessToken)

        val appleCred = OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("synthetic-apple-id", "nonce-xyz")
            .setAccessToken("synthetic-apple-access")
            .build() as OAuthCredential
        assertEquals("apple.com", appleCred.provider)
        assertEquals("synthetic-apple-id", appleCred.idToken)
        assertEquals("synthetic-apple-access", appleCred.accessToken)

        val collisionCaptured = captureWave4AuthFailure {
            throw FirebaseAuthUserCollisionException("ERROR_CREDENTIAL_ALREADY_IN_USE", "Credential in use")
        }
        assertEquals(true, collisionCaptured.getBoolean("threw"))
        assertEquals(true, collisionCaptured.getBoolean("isCollisionSubclass"))
        assertEquals("ERROR_CREDENTIAL_ALREADY_IN_USE", collisionCaptured.getString("errorCode"))

        val alreadyLinkedCaptured = captureWave4AuthFailure {
            throw FirebaseException("User has already been linked to the given provider.")
        }
        assertEquals(true, alreadyLinkedCaptured.getBoolean("threw"))
        assertEquals("FirebaseException", alreadyLinkedCaptured.getString("exceptionClass"))
        assertEquals(true, alreadyLinkedCaptured.getBoolean("alreadyLinkedProviderMessage"))
    } finally {
        runCatching { namedApp.delete() }
        if (createdDefaultApp) {
            runCatching { defaultApp.delete() }
        }
        pumpMainLooper()
    }
}

internal fun runAuthInstanceLinkingReauthAndOauthCredentialsProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val createdUids = mutableListOf<String>()
    val cleanupUidsPath = config.optString("cleanupUidsPath", "")
    val upgradeEmail = "pyric-android-link-$runId@example.com"
    val collisionEmail = "pyric-android-collision-$runId@example.com"
    val initialPassword = "OracleLink1!${runId.takeLast(8)}9A"
    val updatedPassword = "OracleLink2!${runId.takeLast(8)}9B"

    val createdDefaultApp = FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }
    val defaultApp = if (createdDefaultApp) {
        FirebaseApp.initializeApp(context, options)
    } else {
        FirebaseApp.getInstance()
    }
    val tenantApp = FirebaseApp.initializeApp(context, options, "oracle-auth-tenant-$runId")
    val app = FirebaseApp.initializeApp(context, options, "oracle-auth-wave4-$runId")
    try {
        val defaultAuthSameAsKtx = FirebaseAuth.getInstance() === Firebase.auth
        val defaultAuthAppIsDefault = FirebaseAuth.getInstance().app.name == FirebaseApp.DEFAULT_APP_NAME

        val tenantAuth = FirebaseAuth.getInstance(tenantApp)
        val initialTenantIdNull = tenantAuth.tenantId == null
        tenantAuth.setTenantId("tenant-wave4")
        val configuredTenantId = tenantAuth.tenantId

        val auth = FirebaseAuth.getInstance(app)
        val namedAuthSameAsKtx = auth === Firebase.auth(app)
        val authAppMatchesNamed = auth.app === app && auth.app.name == app.name
        val separateAppTenantIdNull = auth.tenantId == null

        auth.setLanguageCode("de")
        val explicitLanguageCode = auth.languageCode
        auth.useAppLanguage()
        val afterUseAppLanguageNonBlank = auth.languageCode == null || auth.languageCode.orEmpty().isNotBlank()

        val anonResult = awaitFirebaseTask(auth.signInAnonymously(), "auth.wave4.signInAnonymously")
        val anonUser = requireNotNull(anonResult.user)
        createdUids.add(anonUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)

        val anonPhoneNumberNull = anonUser.phoneNumber == null
        val anonProviderEntries = describeProviderData(anonUser, null)

        val linkCredential = EmailAuthProvider.getCredential(upgradeEmail, initialPassword)
        val linkedResult = awaitFirebaseTask(
            anonUser.linkWithCredential(linkCredential),
            "auth.wave4.linkWithCredential"
        )
        val linkedUser = requireNotNull(linkedResult.user)
        val linkPreservedUid = linkedUser.uid == anonUser.uid
        val linkedIsAnonymous = linkedUser.isAnonymous
        val linkedEmailMatches = linkedUser.email == upgradeEmail
        val linkedPhoneNumberNull = linkedUser.phoneNumber == null
        val linkedProviderEntries = describeProviderData(linkedUser, upgradeEmail)

        auth.signOut()
        val collisionSeed = awaitFirebaseTask(
            auth.createUserWithEmailAndPassword(collisionEmail, initialPassword),
            "auth.wave4.seedCollisionUser"
        )
        val collisionSeedUser = requireNotNull(collisionSeed.user)
        createdUids.add(collisionSeedUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        auth.signOut()

        val collisionAnonResult = awaitFirebaseTask(
            auth.signInAnonymously(),
            "auth.wave4.signInCollisionAnon"
        )
        val collisionAnonUser = requireNotNull(collisionAnonResult.user)
        createdUids.add(collisionAnonUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)

        val collisionOutcome = captureWave4AuthFailure {
            awaitFirebaseTask(
                collisionAnonUser.linkWithCredential(
                    EmailAuthProvider.getCredential(collisionEmail, initialPassword)
                ),
                "auth.wave4.linkCollision"
            )
        }
        auth.signOut()

        val reloginResult = awaitFirebaseTask(
            auth.signInWithEmailAndPassword(upgradeEmail, initialPassword),
            "auth.wave4.signInLinkedUser"
        )
        val activeLinkedUser = requireNotNull(reloginResult.user)

        val alreadyLinkedProviderOutcome = captureWave4AuthFailure {
            awaitFirebaseTask(
                activeLinkedUser.linkWithCredential(
                    EmailAuthProvider.getCredential(collisionEmail, initialPassword)
                ),
                "auth.wave4.alreadyLinkedProvider"
            )
        }

        val reauthResult = awaitFirebaseTask(
            activeLinkedUser.reauthenticateAndRetrieveData(
                EmailAuthProvider.getCredential(upgradeEmail, initialPassword)
            ),
            "auth.wave4.reauthenticate"
        )
        val reauthSameUid = reauthResult.user?.uid == anonUser.uid

        awaitFirebaseTask(
            activeLinkedUser.updatePassword(updatedPassword),
            "auth.wave4.updatePassword"
        )
        auth.signOut()

        val signInUpdatedCred = EmailAuthProvider.getCredential(upgradeEmail, updatedPassword)
        val updatedSignInResult = awaitFirebaseTask(
            auth.signInWithCredential(signInUpdatedCred),
            "auth.wave4.signInWithUpdatedPasswordCredential"
        )
        val updatedUser = requireNotNull(updatedSignInResult.user)
        val updatedPasswordSameUid = updatedUser.uid == anonUser.uid

        val unlinkResult = awaitFirebaseTask(
            updatedUser.unlink(EmailAuthProvider.PROVIDER_ID),
            "auth.wave4.unlinkPassword"
        )
        val unlinkedUser = requireNotNull(unlinkResult.user)
        val unlinkedProviderIds = JSONArray()
        for (info in unlinkedUser.providerData) {
            unlinkedProviderIds.put(info.providerId)
        }

        auth.signOut()

        val googleCredential = GoogleAuthProvider.getCredential(
            "synthetic-google-id-token",
            "synthetic-google-access-token"
        )
        @Suppress("DEPRECATION")
        val githubCredential = OAuthProvider.getCredential(
            "github.com",
            "synthetic-github-id-token",
            "synthetic-github-access-token"
        ) as OAuthCredential
        val appleCredential = OAuthProvider.newCredentialBuilder("apple.com")
            .setIdTokenWithRawNonce("synthetic-apple-id-token", "raw-nonce-wave4")
            .setAccessToken("synthetic-apple-access-token")
            .build() as OAuthCredential

        val googleRejectOutcome = captureWave4AuthFailure {
            awaitFirebaseTask(
                auth.signInWithCredential(googleCredential),
                "auth.wave4.signInWithGoogleSynthetic"
            )
        }
        val appleRejectOutcome = captureWave4AuthFailure {
            awaitFirebaseTask(
                auth.signInWithCredential(appleCredential),
                "auth.wave4.signInWithAppleSynthetic"
            )
        }

        return JSONObject()
            .put("defaultAuthSameAsFirebaseKtx", defaultAuthSameAsKtx)
            .put("defaultAuthAppIsDefault", defaultAuthAppIsDefault)
            .put("namedAuthSameAsFirebaseKtx", namedAuthSameAsKtx)
            .put("authAppMatchesInitializedApp", authAppMatchesNamed)
            .put("initialTenantIdNull", initialTenantIdNull)
            .put("configuredTenantId", configuredTenantId)
            .put("separateAppTenantIdNull", separateAppTenantIdNull)
            .put("explicitLanguageCode", explicitLanguageCode)
            .put("afterUseAppLanguageValid", afterUseAppLanguageNonBlank)
            .put("anonymousPhoneNumberNull", anonPhoneNumberNull)
            .put("anonymousProviderEntries", anonProviderEntries)
            .put("linkPreservedUid", linkPreservedUid)
            .put("linkedIsAnonymous", linkedIsAnonymous)
            .put("linkedEmailMatches", linkedEmailMatches)
            .put("linkedPhoneNumberNull", linkedPhoneNumberNull)
            .put("linkedProviderEntries", linkedProviderEntries)
            .put("linkCollision", collisionOutcome)
            .put("alreadyLinkedProvider", alreadyLinkedProviderOutcome)
            .put("reauthenticatePreservedUid", reauthSameUid)
            .put("updatedPasswordCredentialSameUid", updatedPasswordSameUid)
            .put("unlinkedProviderIds", unlinkedProviderIds)
            .put("googleCredentialProvider", googleCredential.provider)
            .put("googleCredentialSignInMethod", googleCredential.signInMethod)
            .put("githubOAuthProvider", githubCredential.provider)
            .put("githubOAuthSignInMethod", githubCredential.signInMethod)
            .put("githubOAuthHasIdAndAccessTokens", githubCredential.idToken != null && githubCredential.accessToken != null)
            .put("appleOAuthProvider", appleCredential.provider)
            .put("appleOAuthHasIdAndAccessTokens", appleCredential.idToken != null && appleCredential.accessToken != null)
            .put("googleSyntheticSignInOutcome", googleRejectOutcome)
            .put("appleSyntheticSignInOutcome", appleRejectOutcome)
    } finally {
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        runCatching { app.delete() }
        runCatching { tenantApp.delete() }
        if (createdDefaultApp) {
            runCatching { defaultApp.delete() }
        }
        pumpMainLooper()
    }
}

private fun describeProviderData(user: FirebaseUser, expectedEmail: String?): JSONArray {
    val entries = JSONArray()
    for (info in user.providerData) {
        entries.put(
            JSONObject()
                .put("providerId", info.providerId)
                .put("uidNonBlank", info.uid.isNotBlank())
                .put("uidEqualsUserUid", info.uid == user.uid)
                .put("emailMatchesExpected", expectedEmail != null && info.email == expectedEmail)
                .put("emailIsNull", info.email == null)
                .put("phoneNumberIsNull", info.phoneNumber == null)
        )
    }
    return entries
}

private inline fun captureWave4AuthFailure(block: () -> Unit): JSONObject {
    return try {
        block()
        JSONObject().put("threw", false)
    } catch (err: FirebaseAuthUserCollisionException) {
        JSONObject()
            .put("threw", true)
            .put("exceptionClass", err.javaClass.simpleName)
            .put("isCollisionSubclass", true)
            .put("errorCode", err.errorCode)
    } catch (err: FirebaseAuthException) {
        JSONObject()
            .put("threw", true)
            .put("exceptionClass", err.javaClass.simpleName)
            .put("isCollisionSubclass", false)
            .put("errorCode", err.errorCode)
    } catch (err: FirebaseException) {
        JSONObject()
            .put("threw", true)
            .put("exceptionClass", err.javaClass.simpleName)
            .put("isCollisionSubclass", false)
            .put(
                "alreadyLinkedProviderMessage",
                err.message?.contains("already been linked", ignoreCase = true) == true
            )
    }
}
