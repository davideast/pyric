package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.UserProfileChangeRequest
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.ServerValue
import com.google.firebase.database.getValue
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.net.URI
import java.util.concurrent.TimeUnit

class OracleParityLiveHostConformanceTest {
    private var bridgeClient: PyricBridgeClient? = null
    private lateinit var app: FirebaseApp

    @BeforeEach
    fun setUp() {
        val envUrl = System.getenv("PYRIC_LIVE_BRIDGE_URL")
        Assumptions.assumeTrue(
            !envUrl.isNullOrBlank(),
            "PYRIC_LIVE_BRIDGE_URL is unset; skipping Android 35.2.0 oracle parity live-host conformance test"
        )
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()

        app = FirebaseApp.initializeApp(
            "oracle-parity-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId(PROJECT_ID)
                .setApiKey("demo-live-api-key")
                .setApplicationId("dev.pyric.live.oracle.parity")
                .setDatabaseUrl("https://$PROJECT_ID-default-rtdb.firebaseio.com")
                .build()
        )
        bridgeClient = PyricBridgeClient(url = envUrl)
    }

    @AfterEach
    fun tearDown() {
        val client = bridgeClient
        if (client != null) {
            runBlocking { client.disconnect() }
        }
        bridgeClient = null
        FirebaseDatabase.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("auth-kotlin#23 & rtdb-kotlin#snap-value: live-host parity with Android BoM 35.2.0 oracle captures")
    fun `proves FirebaseUser providerData master firebase entry and RTDB DataSnapshot java lang Long values on live host`() {
        val client = requireNotNull(bridgeClient)
        val auth = FirebaseAuth.getInstance(app, client)
        val database = FirebaseDatabase.getInstance(app, client)

        // 1. Anonymous user: providerId == "firebase", providerData == ["firebase"]
        val anonUser = requireNotNull(
            Tasks.await(auth.signInAnonymously(), 10, TimeUnit.SECONDS).user
        )
        assertEquals("firebase", anonUser.providerId)
        assertEquals(listOf("firebase"), anonUser.providerData.map { it.providerId })
        assertEquals(anonUser.uid, anonUser.providerData[0].uid)
        assertNull(anonUser.providerData[0].email)

        // 2. Custom token user (when provided by live-host harness): providerData == ["firebase"]
        val validCustomToken = System.getenv("PYRIC_LIVE_CUSTOM_TOKEN_VALID")
        if (!validCustomToken.isNullOrBlank()) {
            auth.signOut()
            val customUser = requireNotNull(
                Tasks.await(auth.signInWithCustomToken(validCustomToken), 10, TimeUnit.SECONDS).user
            )
            assertEquals("firebase", customUser.providerId)
            assertEquals(listOf("firebase"), customUser.providerData.map { it.providerId })
            assertEquals("kt-custom-uid-01", customUser.providerData[0].uid)
        }

        // 3. Email/password user: providerId == "firebase", providerData == ["firebase", "password"]
        auth.signOut()
        val email = "oracle-parity-${System.nanoTime()}@example.com"
        val emailResult = Tasks.await(
            auth.createUserWithEmailAndPassword(email, "OracleParity!123"),
            10,
            TimeUnit.SECONDS
        )
        val emailUser = requireNotNull(emailResult.user)
        assertEquals("password", emailResult.additionalUserInfo?.providerId)
        assertEquals("firebase", emailUser.providerId)
        assertEquals(listOf("firebase", "password"), emailUser.providerData.map { it.providerId })
        assertEquals(emailUser.uid, emailUser.providerData[0].uid)
        assertEquals(email, emailUser.providerData[0].email)
        assertEquals(email, emailUser.providerData[1].email)

        val photoUri = URI.create("https://example.com/oracle-parity.png")
        Tasks.await(
            emailUser.updateProfile(
                UserProfileChangeRequest.Builder()
                    .setDisplayName("Oracle Parity User")
                    .setPhotoUri(photoUri)
                    .build()
            ),
            10,
            TimeUnit.SECONDS
        )
        assertEquals("Oracle Parity User", emailUser.providerData[0].displayName)
        assertEquals(photoUri, emailUser.providerData[0].photoUrl)

        // 4. RTDB DataSnapshot.value returns java.lang.Long on live WebSocket bridge
        val uid = emailUser.uid
        val itemRef = database.getReference("profiles/$uid/oracle_parity/counter_doc")
        Tasks.await(
            itemRef.setValue(
                mapOf(
                    "label" to "alpha",
                    "count" to 10L,
                    "series" to listOf(4L, 8L),
                    "weight" to 3.5
                )
            ),
            10,
            TimeUnit.SECONDS
        )
        Tasks.await(
            itemRef.updateChildren(
                mapOf(
                    "count" to ServerValue.increment(5L),
                    "extra" to "kept"
                )
            ),
            10,
            TimeUnit.SECONDS
        )

        val snap = Tasks.await(itemRef.get(), 10, TimeUnit.SECONDS)
        val countVal = snap.child("count").value
        assertNotNull(countVal)
        assertEquals("java.lang.Long", countVal!!::class.java.name)
        assertEquals(15L, countVal)
        assertEquals(15, snap.child("count").getValue(Int::class.java))
        assertEquals(15L, snap.child("count").getValue<Long>())

        @Suppress("UNCHECKED_CAST")
        val seriesList = snap.child("series").value as List<Any?>
        assertEquals(listOf(4L, 8L), seriesList)
        assertTrue(seriesList.all { it != null && it::class.java.name == "java.lang.Long" })

        val weightVal = snap.child("weight").value
        assertNotNull(weightVal)
        assertEquals("java.lang.Double", weightVal!!::class.java.name)
        assertEquals(3.5, weightVal)

        // 5. Federated OAuth user: providerData == ["firebase", "google.com"]
        auth.signOut()
        val oauthUid = "oracle-google-${System.nanoTime()}"
        Tasks.await(
            auth.stageSignInResult(
                providerId = GoogleAuthProvider.PROVIDER_ID,
                uid = oauthUid,
                email = "google-$oauthUid@example.com",
                displayName = "Google Oracle",
                emailVerified = true
            ),
            10,
            TimeUnit.SECONDS
        )
        val oauthRes = Tasks.await(
            auth.signInWithCredential(GoogleAuthProvider.getCredential("g-id-oracle", "g-acc-oracle")),
            10,
            TimeUnit.SECONDS
        )
        val oauthUser = requireNotNull(oauthRes.user)
        assertEquals("google.com", oauthRes.additionalUserInfo?.providerId)
        assertEquals(listOf("firebase", "google.com"), oauthUser.providerData.map { it.providerId })
        assertEquals(oauthUid, oauthUser.providerData[0].uid)
    }

    companion object {
        private const val PROJECT_ID = "demo-kotlin-live"
    }
}
