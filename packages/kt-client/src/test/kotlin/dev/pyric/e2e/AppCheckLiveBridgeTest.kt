package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.component1
import com.google.firebase.appcheck.component2
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.Base64Url
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException

class AppCheckLiveBridgeTest {

    private lateinit var liveBridgeUrl: String
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_APPCHECK_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "Skipping AppCheckLiveBridgeTest: PYRIC_LIVE_APPCHECK_BRIDGE_URL is unset"
        )
        liveBridgeUrl = envUrl!!.trim()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        for (bridge in bridges) {
            runCatching { bridge.terminate() }
        }
        bridges.clear()
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun newBridge(): PyricBridgeClient {
        val client = PyricBridgeClient(url = liveBridgeUrl)
        bridges.add(client)
        return client
    }

    private fun decodeJwtPayload(jwt: String): Map<String, Any?> {
        val parts = jwt.split('.')
        assertEquals(3, parts.size, "Expected 3-segment App Check JWT")
        val payloadJson = String(Base64Url.decodeUnpadded(parts[1]), Charsets.UTF_8)
        return JsonCodec.decodeMap(payloadJson)
    }

    private fun decodeJwtHeader(jwt: String): Map<String, Any?> {
        val parts = jwt.split('.')
        assertEquals(3, parts.size, "Expected 3-segment App Check JWT")
        val headerJson = String(Base64Url.decodeUnpadded(parts[0]), Charsets.UTF_8)
        return JsonCodec.decodeMap(headerJson)
    }

    @Test
    fun mintsRealSandboxAppCheckJwtsWithDebugAndPlayIntegrityProvidersOverOkHttp() {
        val projectId = "demo-kotlin-appcheck"
        val appId = "1:424242424242:android:kotlinliveapp"
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId(appId)
            .setDatabaseUrl("https://$projectId-default-rtdb.firebaseio.com")
            .build()
        val app = FirebaseApp.initializeApp("live-appcheck-primary", options)
        val bridge = newBridge()

        val appCheck = FirebaseAppCheck.getInstance(app, bridge)
        assertEquals(appCheck, Firebase.appCheck(app))

        // Before provider installation, getAppCheckToken fails with FirebaseException.
        val missingProvider = assertThrows<ExecutionException> {
            Tasks.await(appCheck.getAppCheckToken(false))
        }.cause
        assertTrue(missingProvider is FirebaseException)

        val listenerTokens = CopyOnWriteArrayList<String>()
        val listener = FirebaseAppCheck.AppCheckListener { token ->
            listenerTokens.add(token.token)
        }
        appCheck.addAppCheckListener(listener)

        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), true)
        appCheck.setTokenAutoRefreshEnabled(false)
        assertFalse(appCheck.isTokenAutoRefreshEnabled)
        appCheck.setTokenAutoRefreshEnabled(true)
        assertTrue(appCheck.isTokenAutoRefreshEnabled)

        val nowBeforeMint = System.currentTimeMillis()
        val firstToken = Tasks.await(appCheck.getAppCheckToken(false))
        val (jwt1, expireMillis1) = firstToken
        assertTrue(jwt1.isNotBlank())
        // Standard token TTL is 1 hour (~3600s).
        assertTrue(expireMillis1 >= nowBeforeMint + 3_300_000L)
        assertTrue(expireMillis1 <= nowBeforeMint + 3_900_000L)

        val header1 = decodeJwtHeader(jwt1)
        assertEquals("RS256", header1["alg"])
        assertEquals("JWT", header1["typ"])

        val claims1 = decodeJwtPayload(jwt1)
        assertEquals(appId, claims1["sub"])
        @Suppress("UNCHECKED_CAST")
        val aud = claims1["aud"] as List<String>
        assertTrue(aud.contains("projects/424242424242"))
        assertTrue(aud.contains("projects/$projectId"))
        assertEquals("https://firebaseappcheck.googleapis.com/424242424242", claims1["iss"])

        // Cached getAppCheckToken(false) returns the identical token without re-notifying.
        val cachedToken = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals(jwt1, cachedToken.token)
        assertEquals(listOf(jwt1), listenerTokens)

        // Force-refresh mints a brand-new JWT with distinct jti and notifies registered listeners.
        val refreshedToken = Tasks.await(appCheck.getAppCheckToken(true))
        assertNotEquals(jwt1, refreshedToken.token)
        assertNotEquals(claims1["jti"], decodeJwtPayload(refreshedToken.token)["jti"])
        assertEquals(listOf(jwt1, refreshedToken.token), listenerTokens)

        // Limited-use token has ~5-minute TTL and does not overwrite cached session token or fire listeners.
        val limitedBefore = System.currentTimeMillis()
        val limitedToken = Tasks.await(appCheck.getLimitedUseAppCheckToken())
        assertNotEquals(refreshedToken.token, limitedToken.token)
        assertTrue(limitedToken.expireTimeMillis >= limitedBefore + 240_000L)
        assertTrue(limitedToken.expireTimeMillis <= limitedBefore + 360_000L)
        assertEquals(refreshedToken.token, Tasks.await(appCheck.getAppCheckToken(false)).token)
        assertEquals(listOf(jwt1, refreshedToken.token), listenerTokens)

        // Removing listener stops further notifications when switching to PlayIntegrityAppCheckProviderFactory.
        appCheck.removeAppCheckListener(listener)
        appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
        val playIntegrityToken = Tasks.await(appCheck.getAppCheckToken(false))
        assertNotEquals(refreshedToken.token, playIntegrityToken.token)
        assertEquals(appId, decodeJwtPayload(playIntegrityToken.token)["sub"])
        assertEquals(listOf(jwt1, refreshedToken.token), listenerTokens)
    }

    @Test
    fun attachesMintedAppCheckTokenAutomaticallyAcrossSharedFirebaseAppServices() {
        val projectId = "demo-kotlin-appcheck"
        val appId = "1:424242424242:android:sharedservices"
        val options = FirebaseOptions.Builder()
            .setProjectId(projectId)
            .setApiKey("sandbox-api-key")
            .setApplicationId(appId)
            .setDatabaseUrl("https://$projectId-default-rtdb.firebaseio.com")
            .build()
        val app = FirebaseApp.initializeApp("live-appcheck-shared", options)
        val bridge = newBridge()

        // Install App Check in standard Android startup order before service calls.
        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())

        val auth = FirebaseAuth.getInstance(app, bridge)
        val firestore = FirebaseFirestore.getInstance(app, bridge)
        val database = FirebaseDatabase.getInstance(app, bridge)

        val authResult = Tasks.await(
            auth.createUserWithEmailAndPassword("member@example.com", "LiveAppCheck!123")
        )
        val user = authResult.user
        assertNotNull(user)
        val uid = user!!.uid

        Tasks.await(
            firestore.document("items/item-1").set(
                mapOf("ownerUid" to uid, "title" to "verified-item")
            )
        )
        val docSnap = Tasks.await(firestore.document("items/item-1").get())
        assertTrue(docSnap.exists())
        assertEquals("verified-item", docSnap.getString("title"))

        Tasks.await(
            database.getReference("users/$uid/profile").setValue(
                mapOf("displayName" to "AppCheck Member")
            )
        )
        val rtdbSnap = Tasks.await(database.getReference("users/$uid/profile/displayName").get())
        assertEquals("AppCheck Member", rtdbSnap.getValue(String::class.java))

        // Confirm the cached token on FirebaseAppCheck matches what shared services triggered.
        val currentToken = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals(appId, decodeJwtPayload(currentToken.token)["sub"])
    }
}
