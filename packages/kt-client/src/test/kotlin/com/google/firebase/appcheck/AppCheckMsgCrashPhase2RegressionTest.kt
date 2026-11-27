package com.google.firebase.appcheck

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.messaging.FirebaseMessaging
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.FakeReconnectBridge
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AppCheckMsgCrashPhase2RegressionTest {

    private fun testApp(name: String): FirebaseApp =
        FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("p2-kt-proj")
                .setApiKey("demo-key")
                .setApplicationId("1:123:android:abc")
                .build()
        )

    private suspend fun connectClient(bridge: FakeReconnectBridge): PyricBridgeClient {
        val client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        client.connect()
        withTimeout(5000) {
            while (client.connectionState != BridgeConnectionState.ATTACHED) {
                delay(10)
            }
        }
        return client
    }

    @Test
    fun `P2-K08 slow standard AppCheck mint does not overwrite newer forceRefresh token`() = runBlocking {
        val app = testApp("appcheck-gen-${System.nanoTime()}")
        val bridge = FakeReconnectBridge()
        val client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        val firstTcs = TaskCompletionSource<AppCheckToken>()
        val firstStarted = CountDownLatch(1)
        val calls = AtomicInteger(0)

        val provider = AppCheckProvider {
            if (calls.incrementAndGet() == 1) {
                firstStarted.countDown()
                firstTcs.task
            } else {
                Tasks.forResult(
                    object : AppCheckToken() {
                        override val token: String = "tok-fresh"
                        override val expireTimeMillis: Long = System.currentTimeMillis() + 600_000L
                    }
                )
            }
        }

        val appCheck = FirebaseAppCheck.getInstanceForTesting(app, client)
        appCheck.installAppCheckProviderFactory({ provider }, isTokenAutoRefreshEnabled = false)
        val observed = CopyOnWriteArrayList<String>()
        appCheck.addAppCheckListener { observed.add(it.token) }

        val slowTask: Task<AppCheckToken> = appCheck.getAppCheckToken(false)
        assertTrue(firstStarted.await(5, TimeUnit.SECONDS))

        val forced = Tasks.await(appCheck.getAppCheckToken(true), 5, TimeUnit.SECONDS)
        assertEquals("tok-fresh", forced.token)

        firstTcs.setResult(
            object : AppCheckToken() {
                override val token: String = "tok-stale"
                override val expireTimeMillis: Long = System.currentTimeMillis() + 600_000L
            }
        )
        assertEquals("tok-stale", Tasks.await(slowTask, 5, TimeUnit.SECONDS).token)
        assertEquals("tok-fresh", Tasks.await(appCheck.getAppCheckToken(false), 5, TimeUnit.SECONDS).token)
        assertEquals(listOf("tok-fresh"), observed.toList())

        appCheck.dispose()
        client.disconnect()
        bridge.shutdown()
    }

    @Test
    fun `P2-K07 stale Messaging getToken racing deleteToken does not repopulate cache or announce`() = runBlocking {
        val app = testApp("msg-gen-${System.nanoTime()}")
        val bridge = FakeReconnectBridge()
        val client = connectClient(bridge)
        val getTokenId = CopyOnWriteArrayList<String>()
        val getStarted = CountDownLatch(1)

        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                val id = frame["id"] as String
                when (op["method"]) {
                    "messaging.getToken" -> {
                        getTokenId.add(id)
                        getStarted.countDown()
                    }
                    "messaging.deleteToken" -> bridge.current.deliver(
                        mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to emptyMap<String, Any>())
                    )
                }
            }
        }
        val messaging = FirebaseMessaging.getInstance(app, client)

        val slowGet = messaging.token
        assertTrue(getStarted.await(5, TimeUnit.SECONDS))
        Tasks.await(messaging.deleteToken(), 5, TimeUnit.SECONDS)

        bridge.current.deliver(
            mapOf("type" to "worker-res", "id" to getTokenId.first(), "ok" to true, "value" to mapOf("token" to "tok-stale"))
        )
        runCatching { Tasks.await(slowGet, 5, TimeUnit.SECONDS) }

        val secondStarted = CountDownLatch(1)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                @Suppress("UNCHECKED_CAST")
                val op = frame["op"] as Map<String, Any?>
                if (op["method"] == "messaging.getToken") {
                    secondStarted.countDown()
                    bridge.current.deliver(
                        mapOf("type" to "worker-res", "id" to frame["id"]!!, "ok" to true, "value" to mapOf("token" to "tok-new"))
                    )
                }
            }
        }
        val nextTok = Tasks.await(messaging.token, 5, TimeUnit.SECONDS)
        assertTrue(secondStarted.await(5, TimeUnit.SECONDS))
        assertEquals("tok-new", nextTok)

        messaging.close()
        client.disconnect()
        bridge.shutdown()
    }

    @Test
    fun `P2-K13 and P2-K16 Crashlytics getState syncs false and closed instance fails tasks immediately`() = runBlocking {
        val app = testApp("crash-gen-${System.nanoTime()}")
        val bridge = FakeReconnectBridge()
        val client = connectClient(bridge)
        bridge.onFrame = { frame ->
            if (frame["type"] == "worker-op") {
                bridge.current.deliver(
                    mapOf(
                        "type" to "worker-res",
                        "id" to frame["id"]!!,
                        "ok" to true,
                        "value" to mapOf("didCrashOnPreviousExecution" to false)
                    )
                )
            }
        }
        val crash = FirebaseCrashlytics.getInstance(app, client)
        crash.simulatePreviousCrashForTest(true)
        assertTrue(crash.didCrashOnPreviousExecution())

        Tasks.await(crash.getState(), 5, TimeUnit.SECONDS)
        assertFalse(crash.didCrashOnPreviousExecution())

        crash.close()
        assertThrows(ExecutionException::class.java) {
            Tasks.await(crash.checkForUnsentReports(), 2, TimeUnit.SECONDS)
        }
        assertThrows(ExecutionException::class.java) {
            Tasks.await(crash.flush(), 2, TimeUnit.SECONDS)
        }
        assertThrows(ExecutionException::class.java) {
            Tasks.await(crash.getState(), 2, TimeUnit.SECONDS)
        }
        client.disconnect()
        bridge.shutdown()
    }
}
