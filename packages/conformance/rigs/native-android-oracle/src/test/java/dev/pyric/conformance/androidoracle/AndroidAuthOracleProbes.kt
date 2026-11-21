package dev.pyric.conformance.androidoracle

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.UserProfileChangeRequest
import org.json.JSONArray
import org.json.JSONObject

internal fun runAuthAnonymousAndCustomTokenProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-auth-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val createdUids = mutableListOf<String>()
    val cleanupUidsPath = config.optString("cleanupUidsPath", "")
    val app = FirebaseApp.initializeApp(context, options, appName)
    try {
        val auth = FirebaseAuth.getInstance(app)
        val initialSignedOut = auth.currentUser == null

        val anonResult = awaitFirebaseTask(auth.signInAnonymously(), "auth.signInAnonymously")
        val anonUser = requireNotNull(anonResult.user)
        createdUids.add(anonUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        val anonTokenResult = awaitFirebaseTask(anonUser.getIdToken(false), "auth.anon.getIdToken")

        val customToken = config.getString("customToken")
        val customResult = awaitFirebaseTask(
            auth.signInWithCustomToken(customToken),
            "auth.signInWithCustomToken"
        )
        val customUser = requireNotNull(customResult.user)
        val customTokenResult = awaitFirebaseTask(
            customUser.getIdToken(false),
            "auth.custom.getIdToken"
        )
        val claims = customTokenResult.claims

        var invalidCustomErrorCode: String? = null
        try {
            awaitFirebaseTask(
                auth.signInWithCustomToken("not-a-valid-jwt"),
                "auth.signInWithInvalidCustomToken"
            )
        } catch (err: FirebaseAuthException) {
            invalidCustomErrorCode = err.errorCode
        }

        auth.signOut()
        val signedOutAfter = auth.currentUser == null

        val anonProviders = JSONArray()
        for (info in anonUser.providerData) {
            anonProviders.put(info.providerId)
        }

        return JSONObject()
            .put("initialCurrentUserNull", initialSignedOut)
            .put("anonymousIsAnonymous", anonUser.isAnonymous)
            .put("anonymousProviderId", anonUser.providerId)
            .put("anonymousProviderDataIds", anonProviders)
            .put("anonymousSignInProvider", anonTokenResult.signInProvider)
            .put("customIsAnonymous", customUser.isAnonymous)
            .put("customSignInProvider", customTokenResult.signInProvider)
            .put("customRoleClaim", claims["role"])
            .put("customTierClaimNumber", (claims["tier"] as? Number)?.toLong())
            .put("invalidCustomTokenErrorCode", invalidCustomErrorCode)
            .put("signedOutCurrentUserNull", signedOutAfter)
    } finally {
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        app.delete()
    }
}

internal fun runAuthEmailPasswordLifecycleProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-auth-email-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val createdUids = mutableListOf<String>()
    val cleanupUidsPath = config.optString("cleanupUidsPath", "")
    val email = "pyric-android-email-$runId@example.com"
    val password = "OraclePass!${runId.takeLast(8)}9A"

    val app = FirebaseApp.initializeApp(context, options, appName)
    try {
        val auth = FirebaseAuth.getInstance(app)
        val createdResult = awaitFirebaseTask(
            auth.createUserWithEmailAndPassword(email, password),
            "auth.createUserWithEmailAndPassword"
        )
        val createdUser = requireNotNull(createdResult.user)
        createdUids.add(createdUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)

        val createdIsNewUser = createdResult.additionalUserInfo?.isNewUser
        val createdTokenResult = awaitFirebaseTask(
            createdUser.getIdToken(false),
            "auth.createdUser.getIdToken"
        )
        val createdProviders = JSONArray()
        for (info in createdUser.providerData) {
            createdProviders.put(info.providerId)
        }

        auth.signOut()
        val signedOutBetween = auth.currentUser == null

        val signInResult = awaitFirebaseTask(
            auth.signInWithEmailAndPassword(email, password),
            "auth.signInWithEmailAndPassword"
        )
        val signedInUser = requireNotNull(signInResult.user)
        val signedInIsNewUser = signInResult.additionalUserInfo?.isNewUser
        val sameUidOnSignIn = signedInUser.uid == createdUser.uid

        auth.signOut()
        val emailCredential = EmailAuthProvider.getCredential(email, password)
        val credentialResult = awaitFirebaseTask(
            auth.signInWithCredential(emailCredential),
            "auth.signInWithEmailCredential"
        )
        val credentialUser = requireNotNull(credentialResult.user)
        val sameUidOnCredential = credentialUser.uid == createdUser.uid

        awaitFirebaseTask(credentialUser.delete(), "auth.credentialUser.delete")
        pumpMainLooper()
        val currentUserNullAfterDelete = auth.currentUser == null

        return JSONObject()
            .put("createdUidNonBlank", createdUser.uid.isNotBlank())
            .put("createdEmailMatchesInput", createdUser.email == email)
            .put("createdIsAnonymous", createdUser.isAnonymous)
            .put("createdIsEmailVerified", createdUser.isEmailVerified)
            .put("createdIsNewUser", createdIsNewUser)
            .put("createdProviderId", createdUser.providerId)
            .put("createdProviderDataIds", createdProviders)
            .put("createdSignInProvider", createdTokenResult.signInProvider)
            .put("signedOutBetweenSignIns", signedOutBetween)
            .put("signedInSameUid", sameUidOnSignIn)
            .put("signedInIsNewUser", signedInIsNewUser)
            .put("emailCredentialProvider", emailCredential.provider)
            .put("credentialSignInSameUid", sameUidOnCredential)
            .put("currentUserNullAfterDelete", currentUserNullAfterDelete)
    } finally {
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        app.delete()
    }
}

internal fun runAuthProfileReloadAndListenersProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-auth-profile-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val createdUids = mutableListOf<String>()
    val cleanupUidsPath = config.optString("cleanupUidsPath", "")
    val app = FirebaseApp.initializeApp(context, options, appName)
    try {
        val auth = FirebaseAuth.getInstance(app)
        val authStateSnapshots = mutableListOf<Boolean>()
        val idTokenSnapshots = mutableListOf<Boolean>()

        val authListener = FirebaseAuth.AuthStateListener { observedAuth ->
            authStateSnapshots.add(observedAuth.currentUser != null)
        }
        val tokenListener = FirebaseAuth.IdTokenListener { observedAuth ->
            idTokenSnapshots.add(observedAuth.currentUser != null)
        }

        auth.addAuthStateListener(authListener)
        auth.addIdTokenListener(tokenListener)
        try {
            pumpMainLooper()
            val initialAuthEvents = authStateSnapshots.toList()
            val initialIdTokenEvents = idTokenSnapshots.toList()

            val anonResult = awaitFirebaseTask(
                auth.signInAnonymously(),
                "auth.profile.signInAnonymously"
            )
            val user = requireNotNull(anonResult.user)
            createdUids.add(user.uid)
            flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
            pumpMainLooper()

            val authCountAfterSignIn = authStateSnapshots.size
            val tokenCountAfterSignIn = idTokenSnapshots.size

            val request = UserProfileChangeRequest.Builder()
                .setDisplayName("Android Oracle User")
                .setPhotoUri(Uri.parse("https://example.com/android-oracle.png"))
                .build()

            awaitFirebaseTask(user.updateProfile(request), "auth.user.updateProfile")
            val displayAfterUpdate = user.displayName
            val photoAfterUpdate = user.photoUrl?.toString()

            awaitFirebaseTask(user.reload(), "auth.user.reload")
            val reloadedUser = requireNotNull(auth.currentUser)
            val displayAfterReload = reloadedUser.displayName
            val photoAfterReload = reloadedUser.photoUrl?.toString()
            val sameUidAfterReload = reloadedUser.uid == user.uid

            val cachedToken = awaitFirebaseTask(reloadedUser.getIdToken(false), "auth.getIdTokenCached")
            val authCountBeforeForce = authStateSnapshots.size
            val tokenCountBeforeForce = idTokenSnapshots.size
            val forcedToken = awaitFirebaseTask(reloadedUser.getIdToken(true), "auth.getIdTokenForced")
            pumpMainLooper()
            val authCountAfterForce = authStateSnapshots.size
            val tokenCountAfterForce = idTokenSnapshots.size

            auth.removeAuthStateListener(authListener)
            auth.removeIdTokenListener(tokenListener)
            val authCountBeforeSignOut = authStateSnapshots.size
            val tokenCountBeforeSignOut = idTokenSnapshots.size
            auth.signOut()
            pumpMainLooper()

            return JSONObject()
                .put("initialAuthStateEvents", JSONArray(initialAuthEvents))
                .put("initialIdTokenEvents", JSONArray(initialIdTokenEvents))
                .put("authStateIncreasedOnSignIn", authCountAfterSignIn > initialAuthEvents.size)
                .put("idTokenIncreasedOnSignIn", tokenCountAfterSignIn > initialIdTokenEvents.size)
                .put("requestDisplayName", request.displayName)
                .put("requestPhotoUri", request.photoUri?.toString())
                .put("displayNameAfterUpdate", displayAfterUpdate)
                .put("photoUrlAfterUpdate", photoAfterUpdate)
                .put("displayNameAfterReload", displayAfterReload)
                .put("photoUrlAfterReload", photoAfterReload)
                .put("sameUidAfterReload", sameUidAfterReload)
                .put("cachedTokenNonBlank", !cachedToken.token.isNullOrBlank())
                .put("forcedTokenNonBlank", !forcedToken.token.isNullOrBlank())
                .put("hasExpirationTimestamp", forcedToken.expirationTimestamp > 0L)
                .put("hasIssuedAtTimestamp", forcedToken.issuedAtTimestamp > 0L)
                .put("authStateUnchangedOnForceRefresh", authCountAfterForce == authCountBeforeForce)
                .put("idTokenIncreasedOnForceRefresh", tokenCountAfterForce > tokenCountBeforeForce)
                .put(
                    "noEventsAfterRemoveListeners",
                    authStateSnapshots.size == authCountBeforeSignOut &&
                        idTokenSnapshots.size == tokenCountBeforeSignOut
                )
        } finally {
            auth.removeAuthStateListener(authListener)
            auth.removeIdTokenListener(tokenListener)
        }
    } finally {
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        app.delete()
    }
}

internal fun runAuthErrorCodesAndExceptionsProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-auth-errors-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val createdUids = mutableListOf<String>()
    val cleanupUidsPath = config.optString("cleanupUidsPath", "")
    val duplicateEmail = "pyric-android-dup-$runId@example.com"
    val missingEmail = "pyric-android-missing-$runId@example.com"
    val strongPassword = "OraclePass!${runId.takeLast(8)}9A"

    val app = FirebaseApp.initializeApp(context, options, appName)
    try {
        val auth = FirebaseAuth.getInstance(app)

        val invalidEmailOutcome = captureAuthFailure("auth.invalidEmail") {
            awaitFirebaseTask(
                auth.createUserWithEmailAndPassword("not-an-email", strongPassword),
                "auth.errors.invalidEmail"
            )
        }

        val weakPasswordOutcome = captureAuthFailure("auth.weakPassword") {
            val res = awaitFirebaseTask(
                auth.createUserWithEmailAndPassword("pyric-android-weak-$runId@example.com", "123"),
                "auth.errors.weakPassword"
            )
            res.user?.uid?.let { leakedUid ->
                createdUids.add(leakedUid)
                flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
            }
        }

        val seedResult = awaitFirebaseTask(
            auth.createUserWithEmailAndPassword(duplicateEmail, strongPassword),
            "auth.errors.seedDuplicateAccount"
        )
        val seededUser = requireNotNull(seedResult.user)
        createdUids.add(seededUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)

        val duplicateEmailOutcome = captureAuthFailure("auth.duplicateEmail") {
            awaitFirebaseTask(
                auth.createUserWithEmailAndPassword(duplicateEmail, strongPassword),
                "auth.errors.duplicateEmail"
            )
        }

        auth.signOut()

        val wrongPasswordOutcome = captureAuthFailure("auth.wrongPassword") {
            awaitFirebaseTask(
                auth.signInWithEmailAndPassword(duplicateEmail, "WrongPass!000000"),
                "auth.errors.wrongPassword"
            )
        }

        val missingUserOutcome = captureAuthFailure("auth.missingUser") {
            awaitFirebaseTask(
                auth.signInWithEmailAndPassword(missingEmail, strongPassword),
                "auth.errors.missingUser"
            )
        }

        return JSONObject()
            .put("invalidEmail", invalidEmailOutcome)
            .put("weakPassword", weakPasswordOutcome)
            .put("duplicateEmail", duplicateEmailOutcome)
            .put("wrongPassword", wrongPasswordOutcome)
            .put("missingUser", missingUserOutcome)
    } finally {
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        app.delete()
    }
}

private inline fun captureAuthFailure(label: String, block: () -> Unit): JSONObject {
    return try {
        block()
        JSONObject()
            .put("threw", false)
            .put("label", label)
    } catch (err: FirebaseAuthException) {
        JSONObject()
            .put("threw", true)
            .put("exceptionClass", err.javaClass.simpleName)
            .put("errorCode", err.errorCode)
    }
}
