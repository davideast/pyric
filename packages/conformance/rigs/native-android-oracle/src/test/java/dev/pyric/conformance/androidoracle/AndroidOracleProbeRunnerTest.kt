package dev.pyric.conformance.androidoracle

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import java.io.File
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AndroidOracleProbeRunnerTest {

    @Test
    fun localRobolectricSdkSmokeTest() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val appName = "pyric-robolectric-smoke-${System.nanoTime()}"
        val options = FirebaseOptions.Builder()
            .setProjectId("demo-robolectric-oracle")
            .setApplicationId("1:123456789000:android:abcdef012345")
            .setApiKey("AIzaSyDemoRobolectricSmokeKey00000000000")
            .setDatabaseUrl("https://demo-robolectric-oracle-rtdb.firebaseio.com")
            .build()

        val app = FirebaseApp.initializeApp(context, options, appName)
        var database: FirebaseDatabase? = null
        try {
            assertEquals(appName, app.name)
            assertEquals("demo-robolectric-oracle", app.options.projectId)

            val auth = FirebaseAuth.getInstance(app)
            assertNull(auth.currentUser)
            assertNull(auth.tenantId)
            auth.setTenantId("tenant-alpha")
            assertEquals("tenant-alpha", auth.tenantId)
            auth.setLanguageCode("fr")
            assertEquals("fr", auth.languageCode)

            val emailCred = EmailAuthProvider.getCredential("ada@example.com", "Password123!")
            assertEquals("password", emailCred.provider)
            val googleCred = GoogleAuthProvider.getCredential("synthetic-id-token", null)
            assertEquals("google.com", googleCred.provider)

            val db = FirebaseDatabase.getInstance(app, "https://demo-robolectric-oracle-rtdb.firebaseio.com")
            database = db
            db.goOffline()

            val itemRef = db.getReference("pyric_oracle/smoke/items").child("alpha")
            assertEquals("alpha", itemRef.key)
            assertEquals("items", itemRef.parent?.key)
            assertNull(itemRef.root.key)
            assertTrue(ServerValue.TIMESTAMP.isNotEmpty())
            assertNotNull(ServerValue.increment(5L))
        } finally {
            database?.goOffline()
            app.delete()
        }
    }

    @Test
    fun captureSelectedOracleProbe() {
        val rawConfigPath = System.getProperty("pyric.android.oracle.configPath")
        Assume.assumeTrue(
            "pyric.android.oracle.configPath unset; skipping live Android oracle capture",
            !rawConfigPath.isNullOrBlank()
        )
        val configPath = rawConfigPath ?: return

        val configJson = JSONObject(File(configPath).readText(Charsets.UTF_8))
        val probeId = configJson.getString("probeId")
        val outputPath = configJson.getString("outputPath")

        val behavior: JSONObject = when (probeId) {
            "auth-kotlin-anonymous-and-custom-token-session" ->
                runAuthAnonymousAndCustomTokenProbe(configJson)
            "rtdb-kotlin-dedicated-crud-and-query-order" ->
                runRtdbDedicatedCrudAndQueryProbe(configJson)
            else -> throw IllegalArgumentException("Unknown Android oracle probeId: $probeId")
        }

        val outFile = File(outputPath)
        outFile.parentFile?.mkdirs()
        outFile.writeText(behavior.toString(2) + "\n", Charsets.UTF_8)
    }

    private fun runAuthAnonymousAndCustomTokenProbe(config: JSONObject): JSONObject {
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

    private fun flushCleanupUidsSidecar(cleanupUidsPath: String, uids: List<String>) {
        if (cleanupUidsPath.isBlank()) {
            return
        }
        val sidecarFile = File(cleanupUidsPath)
        sidecarFile.parentFile?.mkdirs()
        sidecarFile.writeText(JSONArray(uids).toString() + "\n", Charsets.UTF_8)
    }

    private fun runRtdbDedicatedCrudAndQueryProbe(config: JSONObject): JSONObject {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val runId = config.getString("runId")
        val databaseUrl = config.getString("databaseUrl")
        val appName = "oracle-rtdb-$runId"
        val options = FirebaseOptions.Builder()
            .setProjectId(config.getString("projectId"))
            .setApplicationId(config.getString("applicationId"))
            .setApiKey(config.getString("apiKey"))
            .setDatabaseUrl(databaseUrl)
            .build()

        val app = FirebaseApp.initializeApp(context, options, appName)
        var db: FirebaseDatabase? = null
        try {
            val auth = FirebaseAuth.getInstance(app)
            awaitFirebaseTask(auth.signInWithCustomToken(config.getString("customToken")))

            val database = FirebaseDatabase.getInstance(app, databaseUrl)
            db = database
            database.goOnline()

            val baseRef = database.getReference("pyric_oracle/$runId/rtdb_kotlin")
            try {
                val itemRef = baseRef.child("counter_doc")
                awaitFirebaseTask(itemRef.setValue(mapOf("label" to "alpha", "count" to 10L)))
                awaitFirebaseTask(
                    itemRef.updateChildren(
                        mapOf(
                            "count" to ServerValue.increment(5L),
                            "extra" to "kept"
                        )
                    )
                )

                val snap = awaitFirebaseTask(itemRef.get())
                val countVal = snap.child("count").value

                val catalogRef = baseRef.child("catalog")
                awaitFirebaseTask(
                    catalogRef.setValue(
                        mapOf(
                            "c" to mapOf("score" to 30L),
                            "a" to mapOf("score" to 10L),
                            "b" to mapOf("score" to 20L)
                        )
                    )
                )

                val topTwoSnap = awaitFirebaseTask(
                    catalogRef.orderByChild("score").limitToFirst(2).get()
                )
                val orderedKeys = JSONArray()
                for (child in topTwoSnap.children) {
                    orderedKeys.put(child.key)
                }

                awaitFirebaseTask(itemRef.removeValue())
                val afterRemoveSnap = awaitFirebaseTask(itemRef.get())

                return JSONObject()
                    .put("existsAfterWrite", snap.exists())
                    .put("keyMatches", snap.key == "counter_doc")
                    .put("childrenCount", snap.childrenCount)
                    .put("incrementedCount", (countVal as? Number)?.toLong())
                    .put("integerValueClass", countVal?.javaClass?.name)
                    .put("extraField", snap.child("extra").getValue(String::class.java))
                    .put("orderedLimitToFirstKeys", orderedKeys)
                    .put("existsAfterRemove", afterRemoveSnap.exists())
            } finally {
                runCatching { awaitFirebaseTask(baseRef.removeValue(), 10_000L) }
                auth.signOut()
            }
        } finally {
            db?.goOffline()
            app.delete()
        }
    }

    private fun <T> awaitFirebaseTask(task: Task<T>, timeoutMs: Long = 30_000L): T {
        val mainLooper = Looper.getMainLooper()
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (!task.isComplete) {
            Shadows.shadowOf(mainLooper).idle()
            if (System.nanoTime() >= deadline) {
                throw TimeoutException("Timed out waiting for Firebase Task after ${timeoutMs}ms")
            }
            Thread.sleep(10)
        }
        Shadows.shadowOf(mainLooper).idle()
        if (task.isCanceled) {
            throw CancellationException("Firebase Task was canceled")
        }
        val error = task.exception
        if (error != null) {
            throw error
        }
        @Suppress("UNCHECKED_CAST")
        return task.result as T
    }
}
