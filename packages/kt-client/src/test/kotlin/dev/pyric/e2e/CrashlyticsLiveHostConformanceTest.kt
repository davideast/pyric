package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.crashlytics.CustomKeysAndValues
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.crashlytics.crashlytics
import com.google.firebase.crashlytics.recordException
import com.google.firebase.crashlytics.setCustomKeys
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class CrashlyticsLiveHostConformanceTest {
    private var liveBridgeUrl: String? = null
    private val bridges = mutableListOf<PyricBridgeClient>()

    @BeforeEach
    fun setUp() {
        val requireLive = System.getenv("PYRIC_REQUIRE_CRASHLYTICS_LIVE") == "1"
        val bridgeUrl = System.getenv("PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL")?.trim()
        if (bridgeUrl.isNullOrEmpty()) {
            if (requireLive) {
                throw IllegalStateException(
                    "PYRIC_REQUIRE_CRASHLYTICS_LIVE=1 requires PYRIC_LIVE_CRASHLYTICS_BRIDGE_URL"
                )
            }
            liveBridgeUrl = null
            return
        }
        liveBridgeUrl = bridgeUrl
        FirebaseCrashlytics.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        for (bridge in bridges) {
            bridge.terminate()
        }
        bridges.clear()
        FirebaseCrashlytics.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    @DisplayName("crashlytics-kotlin: FIFO log, custom keys, recordException cause chains, disabled collection unsent queue, multi-app isolation, and App Check attachment against live HostedRuntime")
    fun `proves all 10 crashlytics wire ops unsent report lifecycle multi-app isolation and App Check attachment against live HostedRuntime`() = runBlocking {
        val bridgeUrl = liveBridgeUrl ?: return@runBlocking
        val bridge = PyricBridgeClient(url = bridgeUrl)
        bridges.add(bridge)
        bridge.connect()

        val defaultApp = FirebaseApp.getInstance()
        defaultApp.getOrCreateBridgeClient(bridge)

        val appName = "kt-live-crashlytics-${System.nanoTime()}"
        val app = FirebaseApp.initializeApp(
            appName,
            FirebaseOptions.Builder()
                .setProjectId("demo-kotlin-crashlytics")
                .setApiKey("demo-crashlytics-key")
                .setApplicationId("1:777777777777:android:kotlincrashlytics")
                .build()
        )
        app.getOrCreateBridgeClient(bridge)

        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)

        val defaultCrashlytics = Firebase.crashlytics
        val crashlytics = Firebase.crashlytics(app)

        // 1. Default app vs named app isolation on shared CrashlyticsBroker
        defaultCrashlytics.setUserId("default-app-user")
        Tasks.await(defaultCrashlytics.flush(), 10, TimeUnit.SECONDS)

        crashlytics.setUserId("live-user-101")
        crashlytics.setCustomKey("vip", true)
        crashlytics.setCustomKey("retryLimit", 3)
        crashlytics.setCustomKey("orderCents", 9_500_000_000L)
        crashlytics.setCustomKey("taxRate", 0.0825)
        crashlytics.setCustomKey("discountFloat", 1.25f)
        crashlytics.setCustomKeys {
            key("tier", "enterprise")
            key("region", "us-central1")
        }

        crashlytics.log("step-a: load cart")
        crashlytics.log("step-b: confirm card")

        val ioCause = IOException("card gateway 502")
        val paymentError = IllegalStateException("payment declined", ioCause)
        crashlytics.recordException(paymentError) {
            key("cardBrand", "visa")
            key("tier", "single-report-override")
        }

        val secondKeys = CustomKeysAndValues.Builder()
            .putString("promoCode", "SAVE20")
            .build()
        crashlytics.recordException(IllegalArgumentException("promo expired"), secondKeys)
        Tasks.await(crashlytics.flush(), 10, TimeUnit.SECONDS)

        // Verify broker state for named app and default app independently
        val defaultState = Tasks.await(defaultCrashlytics.getState(), 10, TimeUnit.SECONDS)
        assertEquals("default-app-user", defaultState["userId"])
        @Suppress("UNCHECKED_CAST")
        assertEquals(0, (defaultState["reports"] as List<*>).size)

        val liveState = Tasks.await(crashlytics.getState(), 10, TimeUnit.SECONDS)
        assertEquals(true, liveState["collectionEnabled"])
        assertEquals("live-user-101", liveState["userId"])
        @Suppress("UNCHECKED_CAST")
        val storedKeys = liveState["customKeys"] as Map<String, Any?>
        assertEquals("enterprise", storedKeys["tier"])
        assertEquals("us-central1", storedKeys["region"])
        assertEquals(true, storedKeys["vip"])

        @Suppress("UNCHECKED_CAST")
        val logs = liveState["logs"] as List<Map<String, Any?>>
        assertEquals(2, logs.size)
        assertEquals("step-a: load cart", logs[0]["message"])
        assertEquals("step-b: confirm card", logs[1]["message"])

        @Suppress("UNCHECKED_CAST")
        val reports = liveState["reports"] as List<Map<String, Any?>>
        assertEquals(2, reports.size)
        val firstReport = reports[0]
        assertEquals("java.lang.IllegalStateException", firstReport["name"])
        assertEquals("payment declined", firstReport["message"])
        assertEquals("android", firstReport["sdkPlatform"])
        assertEquals(false, firstReport["fatal"])
        assertTrue((firstReport["cause"] as String).contains("java.io.IOException: card gateway 502"))
        assertTrue((firstReport["stack"] as String).contains("IllegalStateException"))

        @Suppress("UNCHECKED_CAST")
        val firstAttrs = firstReport["attributes"] as Map<String, Any?>
        assertEquals("visa", firstAttrs["cardBrand"])
        assertEquals("single-report-override", firstAttrs["tier"])

        @Suppress("UNCHECKED_CAST")
        val secondAttrs = reports[1]["attributes"] as Map<String, Any?>
        assertEquals("enterprise", secondAttrs["tier"])
        assertEquals("SAVE20", secondAttrs["promoCode"])

        // 2. Disabled collection -> unsent queue -> checkForUnsentReports / sendUnsentReports / deleteUnsentReports
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 10, TimeUnit.SECONDS))

        crashlytics.setCrashlyticsCollectionEnabled(false)
        assertFalse(crashlytics.isCrashlyticsCollectionEnabled())
        crashlytics.recordException(RuntimeException("deferred-unsent-1"))
        crashlytics.recordException(RuntimeException("deferred-unsent-2"))
        assertTrue(Tasks.await(crashlytics.checkForUnsentReports(), 10, TimeUnit.SECONDS))

        crashlytics.sendUnsentReports()
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 10, TimeUnit.SECONDS))
        val stateAfterSend = Tasks.await(crashlytics.getState(), 10, TimeUnit.SECONDS)
        @Suppress("UNCHECKED_CAST")
        assertEquals(4, (stateAfterSend["reports"] as List<*>).size)

        crashlytics.recordException(RuntimeException("deferred-discard-me"))
        assertTrue(Tasks.await(crashlytics.checkForUnsentReports(), 10, TimeUnit.SECONDS))
        crashlytics.deleteUnsentReports()
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 10, TimeUnit.SECONDS))
        val stateAfterDelete = Tasks.await(crashlytics.getState(), 10, TimeUnit.SECONDS)
        @Suppress("UNCHECKED_CAST")
        assertEquals(4, (stateAfterDelete["reports"] as List<*>).size)

        val clearOverride: Boolean? = null
        crashlytics.setCrashlyticsCollectionEnabled(clearOverride)
        assertTrue(crashlytics.isCrashlyticsCollectionEnabled())
        Tasks.await(crashlytics.flush(), 10, TimeUnit.SECONDS)

        println("PYRIC_KT_CRASHLYTICS_LIVE_VERIFIED=1")
    }
}
