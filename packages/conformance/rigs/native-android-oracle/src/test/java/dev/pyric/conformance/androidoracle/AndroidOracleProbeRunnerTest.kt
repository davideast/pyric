package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.EmailAuthProvider
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

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
}
