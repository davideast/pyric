package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import org.json.JSONArray
import org.json.JSONObject

internal fun runAuthAnonymousAndCustomTokenProbe(config: JSONObject): JSONObject {
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

        val anonResult = awaitFirebaseTask(auth.signInAnonymously())
        val anonUser = requireNotNull(anonResult.user)
        createdUids.add(anonUser.uid)
        flushCleanupUidsSidecar(cleanupUidsPath, createdUids)
        val anonTokenResult = awaitFirebaseTask(anonUser.getIdToken(false))

        val customToken = config.getString("customToken")
        val customResult = awaitFirebaseTask(auth.signInWithCustomToken(customToken))
        val customUser = requireNotNull(customResult.user)
        val customTokenResult = awaitFirebaseTask(customUser.getIdToken(false))
        val claims = customTokenResult.claims

        var invalidCustomErrorCode: String? = null
        try {
            awaitFirebaseTask(auth.signInWithCustomToken("not-a-valid-jwt"))
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
