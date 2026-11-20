package dev.pyric.appcheck

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckProviderFactory
import com.google.firebase.appcheck.AppCheckToken
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.appCheck
import com.google.firebase.appcheck.component1
import com.google.firebase.appcheck.component2
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private class CustomTestToken(
    override val token: String,
    override val expireTimeMillis: Long
) : AppCheckToken()

class FirebaseAppCheckTest {

    @AfterEach
    fun tearDown() {
        FirebaseDatabase.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun singletonIdentityAndKtxExtensionsAreScopedPerFirebaseApp() {
        val defaultCheck = FirebaseAppCheck.getInstance()
        assertSame(defaultCheck, Firebase.appCheck)
        assertSame(defaultCheck, FirebaseAppCheck.getInstance(FirebaseApp.getInstance()))

        val secondaryOptions = FirebaseOptions.Builder()
            .setProjectId("demo-app-check")
            .setApiKey("sandbox-key")
            .setApplicationId("1:123456789000:android:secondaryapp")
            .build()
        val secondaryApp = FirebaseApp.initializeApp("secondary-app", secondaryOptions)
        val secondaryCheck = Firebase.appCheck(secondaryApp)

        assertSame(secondaryCheck, FirebaseAppCheck.getInstance(secondaryApp))
        assertNotEquals(defaultCheck, secondaryCheck)
    }

    @Test
    fun getTokenBeforeInstallingProviderFailsWithFirebaseException() {
        val app = FirebaseApp.initializeApp(
            "uninstalled-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-app-check")
                .setApiKey("sandbox-key")
                .setApplicationId("1:123456789000:android:uninstalled")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstance(app)

        val getCause = assertThrows<ExecutionException> {
            Tasks.await(appCheck.getAppCheckToken(false))
        }.cause
        assertTrue(getCause is FirebaseException)
        assertEquals("No AppCheckProvider installed.", getCause?.message)

        val limitedCause = assertThrows<ExecutionException> {
            Tasks.await(appCheck.getLimitedUseAppCheckToken())
        }.cause
        assertTrue(limitedCause is FirebaseException)
        assertEquals("No AppCheckProvider installed.", limitedCause?.message)
    }

    @Test
    fun customProviderCachesValidTokensSupportsForceRefreshExpiryAndDestructuring() {
        val nowMillis = AtomicLong(1_700_000_000_000L)
        val calls = AtomicInteger(0)
        val app = FirebaseApp.initializeApp(
            "custom-provider-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-app-check")
                .setApiKey("sandbox-key")
                .setApplicationId("1:123456789000:android:custom")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstanceForTesting(
            firebaseApp = app,
            clockMillis = { nowMillis.get() }
        )

        val factory = AppCheckProviderFactory { targetApp ->
            assertEquals(app.name, targetApp.name)
            AppCheckProvider {
                val seq = calls.incrementAndGet()
                Tasks.forResult(
                    CustomTestToken(
                        token = "custom-jwt-$seq",
                        expireTimeMillis = nowMillis.get() + 60_000L
                    )
                )
            }
        }
        appCheck.installAppCheckProviderFactory(factory, false)
        assertFalse(appCheck.isTokenAutoRefreshEnabled)

        val first = Tasks.await(appCheck.getAppCheckToken(false))
        val (destructuredJwt, destructuredExp) = first
        assertEquals("custom-jwt-1", destructuredJwt)
        assertEquals(1_700_000_060_000L, destructuredExp)
        assertEquals(1, calls.get())

        val cached = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("custom-jwt-1", cached.token)
        assertEquals(1, calls.get())

        val forced = Tasks.await(appCheck.getAppCheckToken(true))
        assertEquals("custom-jwt-2", forced.token)
        assertEquals(2, calls.get())

        // Advance past expiry so forceRefresh=false mints a new token.
        nowMillis.addAndGet(61_000L)
        val afterExpiry = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("custom-jwt-3", afterExpiry.token)
        assertEquals(3, calls.get())

        // Limited-use bypasses and preserves the cached session token.
        val limited = Tasks.await(appCheck.getLimitedUseAppCheckToken())
        assertEquals("custom-jwt-4", limited.token)
        assertEquals(4, calls.get())
        val stillCached = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("custom-jwt-3", stillCached.token)
        assertEquals(4, calls.get())
    }

    @Test
    fun listenersReceiveImmediateCachedTokenUpdatesAndRespectRemoval() {
        val counter = AtomicInteger(0)
        val app = FirebaseApp.initializeApp(
            "listener-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-app-check")
                .setApiKey("sandbox-key")
                .setApplicationId("1:123456789000:android:listener")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory {
            AppCheckProvider {
                val n = counter.incrementAndGet()
                Tasks.forResult(
                    CustomTestToken(
                        token = "listener-jwt-$n",
                        expireTimeMillis = System.currentTimeMillis() + 3_600_000L
                    )
                )
            }
        }

        val observed = CopyOnWriteArrayList<String>()
        val listener = FirebaseAppCheck.AppCheckListener { token ->
            observed.add(token.token)
        }
        appCheck.addAppCheckListener(listener)
        assertEquals(emptyList<String>(), observed)

        Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals(listOf("listener-jwt-1"), observed)

        // Cached hit does not re-fire the listener.
        Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals(listOf("listener-jwt-1"), observed)

        // Late-registered listener receives the valid cached token immediately.
        val lateObserved = CopyOnWriteArrayList<String>()
        val lateListener = FirebaseAppCheck.AppCheckListener { token ->
            lateObserved.add(token.token)
        }
        appCheck.addAppCheckListener(lateListener)
        assertEquals(listOf("listener-jwt-1"), lateObserved)

        // Limited-use token does not fire AppCheckListeners.
        Tasks.await(appCheck.getLimitedUseAppCheckToken())
        assertEquals(listOf("listener-jwt-1"), observed)

        // Force-refresh notifies active listeners, while removed listeners stay silent.
        appCheck.removeAppCheckListener(lateListener)
        Tasks.await(appCheck.getAppCheckToken(true))
        assertEquals(listOf("listener-jwt-1", "listener-jwt-3"), observed)
        assertEquals(listOf("listener-jwt-1"), lateObserved)
    }

    @Test
    fun setTokenAutoRefreshEnabledRespectsDataCollectionFlagAndRefreshesExpiringToken() {
        val counter = AtomicInteger(0)
        val refreshedLatch = CountDownLatch(2)
        val app = FirebaseApp.initializeApp(
            "autorefresh-app",
            FirebaseOptions.Builder()
                .setProjectId("demo-app-check")
                .setApiKey("sandbox-key")
                .setApplicationId("1:123456789000:android:autorefresh")
                .build()
        )
        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(
            {
                AppCheckProvider {
                    val seq = counter.incrementAndGet()
                    val ttlMs = if (seq == 1) 120L else 3_600_000L
                    Tasks.forResult(
                        CustomTestToken(
                            token = "refresh-jwt-$seq",
                            expireTimeMillis = System.currentTimeMillis() + ttlMs
                        )
                    )
                }
            },
            false
        )
        assertFalse(appCheck.isTokenAutoRefreshEnabled)

        app.isDataCollectionDefaultEnabled = false
        appCheck.setTokenAutoRefreshEnabled(true)
        assertFalse(appCheck.isTokenAutoRefreshEnabled)

        app.isDataCollectionDefaultEnabled = true
        appCheck.setTokenAutoRefreshEnabled(true)
        assertTrue(appCheck.isTokenAutoRefreshEnabled)

        appCheck.addAppCheckListener { refreshedLatch.countDown() }
        val first = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("refresh-jwt-1", first.token)

        assertTrue(refreshedLatch.await(3, TimeUnit.SECONDS))
        val refreshed = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("refresh-jwt-2", refreshed.token)
    }

    @Test
    fun debugAndPlayIntegrityFactoriesMintViaBridgeAndAttachTokenToSharedAppRequests() {
        val sentOps = CopyOnWriteArrayList<Map<String, Any?>>()
        val transport = InMemoryBridgeTransport()
        val mintCounter = AtomicInteger(0)

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"]) {
                "attach" -> transport.sendToClient(
                    """{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"s-appcheck"}"""
                )
                "worker-sub" -> {
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as? Map<String, Any?> ?: emptyMap()
                    val subId = msg["subId"] as String
                    if (sub["target"] == "authState" || sub["target"] == "idToken") {
                        transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                    }
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    sentOps.add(op)
                    when (op["method"]) {
                        "appCheck.getToken" -> {
                            val seq = mintCounter.incrementAndGet()
                            val exp = System.currentTimeMillis() + 3_600_000L
                            val provider = op["provider"]
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"bridge-$provider-jwt-$seq","expireTimeMillis":$exp}}"""
                            )
                        }
                        "appCheck.getLimitedUseToken" -> {
                            val seq = mintCounter.incrementAndGet()
                            val exp = System.currentTimeMillis() + 300_000L
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"bridge-limited-jwt-$seq","expireTimeMillis":$exp}}"""
                            )
                        }
                        "setDoc" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "rtdb.set" -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                        "auth.signInAnonymously" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"anon-1","isAnonymous":true,"providerData":[]}}}"""
                            )
                        }
                    }
                }
            }
        }

        val options = FirebaseOptions.Builder()
            .setProjectId("demo-shared-app")
            .setApiKey("sandbox-key")
            .setApplicationId("1:987654321000:android:sharedclient")
            .setDatabaseUrl("https://demo-shared-app-default-rtdb.firebaseio.com")
            .build()
        val app = FirebaseApp.initializeApp("shared-bridge-app", options)
        val bridge = PyricBridgeClient(transport)

        val firestore = FirebaseFirestore.getInstance(app, bridge)
        val database = FirebaseDatabase.getInstance(app, bridge)
        val auth = FirebaseAuth.getInstance(app, bridge)

        // Before installing an AppCheckProviderFactory, shared requests carry no appCheckToken.
        Tasks.await(firestore.document("items/before-install").set(mapOf("step" to 0)))
        val preInstallSet = sentOps.first { it["method"] == "setDoc" }
        assertFalse(preInstallSet.containsKey("appCheckToken"))

        // Install DebugAppCheckProviderFactory via FirebaseAppCheck.getInstance(app).
        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())

        // Subsequent Firestore, RTDB, and Auth calls automatically mint once and attach appCheckToken.
        Tasks.await(firestore.document("items/after-debug").set(mapOf("step" to 1)))
        Tasks.await(database.getReference("users/u1").setValue(mapOf("active" to true)))
        Tasks.await(auth.signInAnonymously())

        val postDebugSetDoc = sentOps.last { it["method"] == "setDoc" }
        val postDebugRtdb = sentOps.last { it["method"] == "rtdb.set" }
        val postDebugAuth = sentOps.last { it["method"] == "auth.signInAnonymously" }
        assertEquals("bridge-debug-jwt-1", postDebugSetDoc["appCheckToken"])
        assertEquals("bridge-debug-jwt-1", postDebugRtdb["appCheckToken"])
        assertEquals("bridge-debug-jwt-1", postDebugAuth["appCheckToken"])

        val mintOp = sentOps.first { it["method"] == "appCheck.getToken" }
        assertEquals("1:987654321000:android:sharedclient", mintOp["appId"])
        assertEquals("demo-shared-app", mintOp["projectId"])
        assertEquals("debug", mintOp["provider"])

        // Switching to PlayIntegrityAppCheckProviderFactory clears the debug token and mints play-integrity.
        appCheck.installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
        val playToken = Tasks.await(appCheck.getAppCheckToken(false))
        assertEquals("bridge-play-integrity-jwt-2", playToken.token)

        val limited = Tasks.await(appCheck.getLimitedUseAppCheckToken())
        assertEquals("bridge-limited-jwt-3", limited.token)

        Tasks.await(firestore.document("items/after-play").set(mapOf("step" to 2)))
        assertEquals("bridge-play-integrity-jwt-2", sentOps.last { it["method"] == "setDoc" }["appCheckToken"])
    }
}
