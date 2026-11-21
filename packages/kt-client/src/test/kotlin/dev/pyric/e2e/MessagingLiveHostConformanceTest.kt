package dev.pyric.e2e

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.google.firebase.messaging.SendException
import com.google.firebase.messaging.messaging
import com.google.firebase.messaging.remoteMessage
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit

class MessagingLiveHostConformanceTest {
    private var liveBridgeUrl: String? = null
    private var adminDriverUrl: String? = null
    private val bridges = mutableListOf<PyricBridgeClient>()
    private val httpClient = OkHttpClient()

    @BeforeEach
    fun setUp() {
        val requireLive = System.getenv("PYRIC_REQUIRE_MESSAGING_LIVE") == "1"
        val bridgeUrl = System.getenv("PYRIC_LIVE_MESSAGING_BRIDGE_URL")?.trim()
        val driverUrl = System.getenv("PYRIC_LIVE_MESSAGING_ADMIN_URL")?.trim()
        if (bridgeUrl.isNullOrEmpty() || driverUrl.isNullOrEmpty()) {
            if (requireLive) {
                throw IllegalStateException(
                    "PYRIC_REQUIRE_MESSAGING_LIVE=1 requires PYRIC_LIVE_MESSAGING_BRIDGE_URL and PYRIC_LIVE_MESSAGING_ADMIN_URL"
                )
            }
            liveBridgeUrl = null
            adminDriverUrl = null
            return
        }
        liveBridgeUrl = bridgeUrl
        adminDriverUrl = driverUrl
        FirebaseMessaging.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @AfterEach
    fun tearDown() {
        for (bridge in bridges) {
            bridge.terminate()
        }
        bridges.clear()
        FirebaseMessaging.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun postAdminAction(payload: Map<String, Any?>): Map<String, Any?> {
        val url = requireNotNull(adminDriverUrl)
        val bodyJson = JsonCodec.encodeToString(payload)
        val request = Request.Builder()
            .url(url)
            .post(bodyJson.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        httpClient.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            return JsonCodec.decodeMap(text)
        }
    }

    @Test
    @DisplayName("messaging-kotlin: token stability, deleteToken invalidation, topic & condition fanout, visible/hidden foreground & background routing, send callbacks, and App Check attachment")
    fun `proves FCM token lifecycle topic and condition fanout visibility routing and send callbacks against live HostedRuntime`() = runBlocking {
        val bridgeUrl = liveBridgeUrl ?: return@runBlocking
        val bridge = PyricBridgeClient(url = bridgeUrl)
        bridges.add(bridge)
        bridge.connect()

        val app = FirebaseApp.initializeApp(
            "kt-live-fcm-${System.nanoTime()}",
            FirebaseOptions.Builder()
                .setProjectId("demo-kotlin-messaging")
                .setApiKey("demo-messaging-key")
                .setApplicationId("1:999999999999:android:kotlinmessaging")
                .build()
        )
        app.getOrCreateBridgeClient(bridge)

        val appCheck = FirebaseAppCheck.getInstance(app)
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)

        val messaging = Firebase.messaging(app)

        val onNewTokens = CopyOnWriteArrayList<String>()
        val serviceReceived = CopyOnWriteArrayList<RemoteMessage>()
        val sentLatch = CountDownLatch(1)
        val sendErrorLatch = CountDownLatch(1)
        val sentIds = CopyOnWriteArrayList<String>()
        val sendErrors = CopyOnWriteArrayList<SendException>()

        messaging.registerService(object : FirebaseMessagingService() {
            override fun onNewToken(token: String) {
                onNewTokens.add(token)
            }

            override fun onMessageReceived(message: RemoteMessage) {
                serviceReceived.add(message)
            }

            override fun onMessageSent(msgId: String) {
                sentIds.add(msgId)
                sentLatch.countDown()
            }

            override fun onSendError(msgId: String, exception: Exception) {
                if (exception is SendException) {
                    sendErrors.add(exception)
                }
                sendErrorLatch.countDown()
            }
        })

        // 1. Token stability + deleteToken immediate broker invalidation + fresh re-mint
        val token1 = Tasks.await(messaging.token, 10, TimeUnit.SECONDS)
        val token1Repeat = Tasks.await(messaging.token, 10, TimeUnit.SECONDS)
        assertEquals(token1, token1Repeat)
        assertTrue(token1.contains(":"))

        Tasks.await(messaging.deleteToken(), 10, TimeUnit.SECONDS)
        val deadSendRes = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "token" to token1,
                    "data" to mapOf("probe" to "after-delete")
                )
            )
        )
        assertEquals(false, deadSendRes["ok"])
        @Suppress("UNCHECKED_CAST")
        val deadErr = deadSendRes["error"] as Map<String, Any?>
        assertEquals("NOT_FOUND", deadErr["code"])

        val activeToken = Tasks.await(messaging.token, 10, TimeUnit.SECONDS)
        assertNotEquals(token1, activeToken)
        assertEquals(listOf(token1, activeToken), onNewTokens.toList())

        // 2. Open explicit foreground & background Flow collectors and verify hidden vs visible routing
        val fgCollector = CopyOnWriteArrayList<RemoteMessage>()
        val bgCollector = CopyOnWriteArrayList<RemoteMessage>()
        val fgJob = launch(kotlinx.coroutines.Dispatchers.IO) {
            messaging.foregroundMessages.collect { fgCollector.add(it) }
        }
        val bgJob = launch(kotlinx.coroutines.Dispatchers.IO) {
            messaging.backgroundMessages.collect { bgCollector.add(it) }
        }
        delay(200)

        // Hidden state -> token send routes exclusively to backgroundMessages (data-only has null notification)
        Tasks.await(messaging.setVisibility(false), 10, TimeUnit.SECONDS)
        val bgTokenSend = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "token" to activeToken,
                    "data" to mapOf("kind" to "bg-token-data")
                )
            )
        )
        assertEquals(true, bgTokenSend["ok"])
        withTimeout(5_000) {
            while (bgCollector.none { it.data["kind"] == "bg-token-data" }) {
                delay(20)
            }
        }
        val bgDataMsg = bgCollector.first { it.data["kind"] == "bg-token-data" }
        assertNull(bgDataMsg.notification)
        assertEquals("999999999999", bgDataMsg.from)
        assertTrue(fgCollector.none { it.data["kind"] == "bg-token-data" })

        // Visible state -> token send + notification routes exclusively to foregroundMessages
        Tasks.await(messaging.setVisibility(true), 10, TimeUnit.SECONDS)
        val fgTokenSend = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "token" to activeToken,
                    "data" to mapOf("kind" to "fg-token-notif"),
                    "notification" to mapOf(
                        "title" to "Live Alert",
                        "body" to "Foreground delivery",
                        "imageUrl" to "https://example.com/live.png"
                    )
                )
            )
        )
        assertEquals(true, fgTokenSend["ok"])
        withTimeout(5_000) {
            while (fgCollector.none { it.data["kind"] == "fg-token-notif" }) {
                delay(20)
            }
        }
        val fgNotifMsg = fgCollector.first { it.data["kind"] == "fg-token-notif" }
        assertEquals("Live Alert", fgNotifMsg.notification?.title)
        assertEquals("Foreground delivery", fgNotifMsg.notification?.body)
        assertEquals(URI.create("https://example.com/live.png"), fgNotifMsg.notification?.imageUrl)
        assertTrue(bgCollector.none { it.data["kind"] == "fg-token-notif" })

        // 3. Topic & boolean condition fanout + unsubscribeFromTopic stop
        Tasks.await(messaging.subscribeToTopic("/topics/orders"), 10, TimeUnit.SECONDS)
        Tasks.await(messaging.subscribeToTopic("vip"), 10, TimeUnit.SECONDS)

        val condSend = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "condition" to "'orders' in topics && 'vip' in topics",
                    "data" to mapOf("kind" to "condition-match")
                )
            )
        )
        assertEquals(true, condSend["ok"])
        withTimeout(5_000) {
            while (fgCollector.none { it.data["kind"] == "condition-match" }) {
                delay(20)
            }
        }

        Tasks.await(messaging.unsubscribeFromTopic("orders"), 10, TimeUnit.SECONDS)
        val unsubscribedSend = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "topic" to "orders",
                    "data" to mapOf("kind" to "should-not-arrive")
                )
            )
        )
        assertEquals(true, unsubscribedSend["ok"])

        // Send a subsequent vip message to prove ordering and confirm should-not-arrive was skipped
        val vipFollowup = postAdminAction(
            mapOf(
                "action" to "send",
                "message" to mapOf(
                    "topic" to "vip",
                    "data" to mapOf("kind" to "vip-still-subscribed")
                )
            )
        )
        assertEquals(true, vipFollowup["ok"])
        withTimeout(5_000) {
            while (fgCollector.none { it.data["kind"] == "vip-still-subscribed" }) {
                delay(20)
            }
        }
        assertTrue(fgCollector.none { it.data["kind"] == "should-not-arrive" })

        // Direct messaging.deliver driver routes custom senderId & payload to active route
        val directDeliver = postAdminAction(
            mapOf(
                "action" to "deliver",
                "spec" to mapOf(
                    "from" to "111222333444",
                    "messageId" to "deliver-custom-1",
                    "data" to mapOf("kind" to "direct-deliver")
                )
            )
        )
        assertEquals(true, directDeliver["ok"])
        withTimeout(5_000) {
            while (fgCollector.none { it.data["kind"] == "direct-deliver" }) {
                delay(20)
            }
        }
        val deliveredMsg = fgCollector.first { it.data["kind"] == "direct-deliver" }
        assertEquals("111222333444", deliveredMsg.from)
        assertEquals("111222333444", deliveredMsg.senderId)
        assertEquals("deliver-custom-1", deliveredMsg.messageId)

        // 4. Local topic validation failure & client send() callbacks (onMessageSent + SendException.ERROR_SIZE)
        val badTopicErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(messaging.subscribeToTopic("invalid topic spaces"), 5, TimeUnit.SECONDS)
        }
        assertTrue(badTopicErr.cause is IllegalArgumentException)

        messaging.send(
            remoteMessage("/topics/vip") {
                messageId = "client-upstream-1"
                addData("kind", "from-kotlin-send")
            }
        )
        assertTrue(sentLatch.await(10, TimeUnit.SECONDS))
        assertEquals(listOf("client-upstream-1"), sentIds.toList())
        withTimeout(5_000) {
            while (fgCollector.none { it.data["kind"] == "from-kotlin-send" }) {
                delay(20)
            }
        }

        messaging.send(
            remoteMessage("/topics/vip") {
                messageId = "client-oversized-1"
                addData("blob", "z".repeat(5_000))
            }
        )
        assertTrue(sendErrorLatch.await(10, TimeUnit.SECONDS))
        assertEquals(SendException.ERROR_SIZE, sendErrors.first().errorCode)

        // Verify FirebaseMessagingService received all routed messages across hidden & visible states
        assertTrue(serviceReceived.any { it.data["kind"] == "bg-token-data" })
        assertTrue(serviceReceived.any { it.data["kind"] == "fg-token-notif" })
        assertTrue(serviceReceived.any { it.data["kind"] == "condition-match" })

        fgJob.cancel()
        bgJob.cancel()
        println("PYRIC_KT_MESSAGING_LIVE_VERIFIED=1")
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
