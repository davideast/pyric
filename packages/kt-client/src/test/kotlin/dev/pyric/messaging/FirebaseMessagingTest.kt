package dev.pyric.messaging

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.google.firebase.messaging.SendException
import com.google.firebase.messaging.deliveryMetricsExportToBigQuery
import com.google.firebase.messaging.messaging
import com.google.firebase.messaging.remoteMessage
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.IOException
import java.net.URI
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FirebaseMessagingTest {
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private val recordedOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val activeSubs = LinkedHashMap<String, String>()
    private val tokenMintCounter = AtomicInteger(0)
    private val registrations = LinkedHashMap<String, String>()

    @BeforeEach
    fun setUp() {
        FirebaseMessaging.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        recordedOps.clear()
        synchronized(activeSubs) { activeSubs.clear() }
        tokenMintCounter.set(0)
        synchronized(registrations) { registrations.clear() }

        transport = InMemoryBridgeTransport()
        transport.onServerReceive { raw ->
            val msg = JsonCodec.decodeMap(raw)
            when (msg["type"]) {
                "attach" -> {
                    transport.sendToClient(
                        """{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"unit-fcm-session"}"""
                    )
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = msg["sub"] as Map<String, Any?>
                    val target = sub["target"]?.toString().orEmpty()
                    synchronized(activeSubs) {
                        activeSubs[subId] = target
                    }
                }
                "worker-unsub" -> {
                    val subId = msg["subId"] as String
                    synchronized(activeSubs) {
                        activeSubs.remove(subId)
                    }
                }
                "worker-op" -> handleWorkerOp(msg)
            }
        }
        bridgeClient = PyricBridgeClient(transport)
    }

    @AfterEach
    fun tearDown() {
        FirebaseMessaging.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun handleWorkerOp(msg: Map<String, Any?>) {
        val id = msg["id"] as String
        @Suppress("UNCHECKED_CAST")
        val op = msg["op"] as Map<String, Any?>
        recordedOps.add(op)
        when (op["method"] as String) {
            "messaging.getToken" -> {
                val regId = (op["registrationId"] as? String) ?: "swreg-port-default"
                val token = synchronized(registrations) {
                    registrations.getOrPut(regId) {
                        val seq = tokenMintCounter.incrementAndGet()
                        "fcmUnitInstance$seq:APA91bUnitTokenPayload$seq"
                    }
                }
                val reply = JsonCodec.encodeToString(
                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to mapOf("token" to token))
                )
                transport.sendToClient(reply)
            }
            "messaging.deleteToken" -> {
                val regId = (op["registrationId"] as? String) ?: "swreg-port-default"
                synchronized(registrations) {
                    registrations.remove(regId)
                }
                val reply = JsonCodec.encodeToString(
                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to true)
                )
                transport.sendToClient(reply)
            }
            "messaging.subscribeToTopic", "messaging.unsubscribeFromTopic" -> {
                val topic = op["topic"] as String
                val outcome = if (topic == "force-broker-failure") {
                    mapOf(
                        "successCount" to 0,
                        "failureCount" to 1,
                        "errors" to listOf(mapOf("index" to 0, "reason" to "unregistered-token"))
                    )
                } else {
                    mapOf("successCount" to 1, "failureCount" to 0, "errors" to emptyList<Any>())
                }
                val reply = JsonCodec.encodeToString(
                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to outcome)
                )
                transport.sendToClient(reply)
            }
            "messaging.setVisibility" -> {
                val reply = JsonCodec.encodeToString(
                    mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to null)
                )
                transport.sendToClient(reply)
            }
            "messaging.send" -> {
                @Suppress("UNCHECKED_CAST")
                val wireMsg = op["message"] as Map<String, Any?>
                val tokenTarget = wireMsg["token"] as? String
                @Suppress("UNCHECKED_CAST")
                val dataMap = wireMsg["data"] as? Map<String, String>
                val dataBytes = dataMap?.entries?.sumOf { it.key.length + it.value.length } ?: 0
                when {
                    dataBytes > 4_915 -> {
                        val errReply = JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf(
                                    "code" to "INVALID_ARGUMENT",
                                    "message" to "Message is too large. The maximum is 4K (4096 bytes)."
                                )
                            )
                        )
                        transport.sendToClient(errReply)
                    }
                    tokenTarget == "dead-token" -> {
                        val errReply = JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf(
                                    "code" to "NOT_FOUND",
                                    "message" to "Requested entity was not found."
                                )
                            )
                        )
                        transport.sendToClient(errReply)
                    }
                    tokenTarget == "quota-token" -> {
                        val errReply = JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to false,
                                "error" to mapOf(
                                    "code" to "RESOURCE_EXHAUSTED",
                                    "message" to "Quota exceeded for messaging."
                                )
                            )
                        )
                        transport.sendToClient(errReply)
                    }
                    else -> {
                        val reply = JsonCodec.encodeToString(
                            mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to mapOf(
                                    "name" to "projects/demo-fcm/messages/accepted-101",
                                    "messageId" to "accepted-101",
                                    "validateOnly" to false
                                )
                            )
                        )
                        transport.sendToClient(reply)
                    }
                }
            }
        }
    }

    private fun pushSnapToTarget(targetName: String, payload: Map<String, Any?>) {
        val matchingSubIds = synchronized(activeSubs) {
            activeSubs.filterValues { it == targetName }.keys.toList()
        }
        for (subId in matchingSubIds) {
            val snapJson = JsonCodec.encodeToString(
                mapOf("type" to "worker-snap", "subId" to subId, "value" to payload)
            )
            transport.sendToClient(snapJson)
        }
    }

    private fun newApp(name: String): FirebaseApp {
        return FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("demo-fcm-unit")
                .setApiKey("demo-api-key")
                .setApplicationId("1:999999999999:android:fcmunit")
                .build()
        )
    }

    @Test
    fun `singleton KTX token deduplication caching deleteToken and settings match upstream`() = runBlocking {
        val defaultApp = FirebaseApp.getInstance()
        defaultApp.getOrCreateBridgeClient(bridgeClient)
        val secondaryApp = newApp("secondary-fcm")
        secondaryApp.getOrCreateBridgeClient(bridgeClient)

        assertEquals("FCM", FirebaseMessaging.INSTANCE_ID_SCOPE)
        assertSame(FirebaseMessaging.getInstance(), Firebase.messaging)
        assertSame(FirebaseMessaging.getInstance(secondaryApp), Firebase.messaging(secondaryApp))
        assertNotSame(Firebase.messaging, Firebase.messaging(secondaryApp))

        val messaging = Firebase.messaging
        val newTokens = CopyOnWriteArrayList<String>()
        val unregisteredTokens = CopyOnWriteArrayList<String>()
        val service = object : FirebaseMessagingService() {
            override fun onNewToken(token: String) {
                newTokens.add(token)
            }

            override fun onUnregistered(token: String) {
                unregisteredTokens.add(token)
            }
        }
        messaging.registerService(service)

        // 5 concurrent getToken() calls deduplicate to a single wire op
        val concurrentTokens = (1..5).map {
            async { Tasks.await(messaging.token, 5, TimeUnit.SECONDS) }
        }.awaitAll()
        val firstToken = concurrentTokens.first()
        assertTrue(concurrentTokens.all { it == firstToken })
        assertEquals(1, recordedOps.count { it["method"] == "messaging.getToken" })
        assertEquals(listOf(firstToken), newTokens.toList())

        // Cached getToken() + register() reuse the cached token without extra wire ops
        assertEquals(firstToken, Tasks.await(messaging.token, 5, TimeUnit.SECONDS))
        Tasks.await(messaging.register(), 5, TimeUnit.SECONDS)
        assertEquals(1, recordedOps.count { it["method"] == "messaging.getToken" })

        // Secondary app uses a distinct registrationId and mints an independent token
        val secondaryToken = Tasks.await(Firebase.messaging(secondaryApp).token, 5, TimeUnit.SECONDS)
        assertNotEquals(firstToken, secondaryToken)

        // deleteToken() clears cache, fires onUnregistered, and next token mints a new value
        Tasks.await(messaging.deleteToken(), 5, TimeUnit.SECONDS)
        assertEquals(listOf(firstToken), unregisteredTokens.toList())
        val remintedToken = Tasks.await(messaging.token, 5, TimeUnit.SECONDS)
        assertNotEquals(firstToken, remintedToken)
        assertEquals(listOf(firstToken, remintedToken), newTokens.toList())

        // Settings flags: autoInit, BigQuery export, notification delegation
        assertTrue(messaging.isAutoInitEnabled)
        messaging.isAutoInitEnabled = false
        assertFalse(messaging.isAutoInitEnabled)

        assertFalse(messaging.deliveryMetricsExportToBigQueryEnabled())
        messaging.setDeliveryMetricsExportToBigQuery(true)
        assertTrue(messaging.deliveryMetricsExportToBigQueryEnabled())
        assertTrue(messaging.deliveryMetricsExportToBigQuery)

        assertFalse(messaging.isNotificationDelegationEnabled)
        Tasks.await(messaging.setNotificationDelegationEnabled(true), 5, TimeUnit.SECONDS)
        assertTrue(messaging.isNotificationDelegationEnabled)
    }

    @Test
    fun `topic validation strips prefix rejects malformed names locally and checks broker outcome`() {
        val app = newApp("topics-app")
        val messaging = FirebaseMessaging.getInstance(app, bridgeClient)

        Tasks.await(messaging.subscribeToTopic("/topics/weather.alerts_v1~us%20"), 5, TimeUnit.SECONDS)
        val subOp = recordedOps.last { it["method"] == "messaging.subscribeToTopic" }
        assertEquals("weather.alerts_v1~us%20", subOp["topic"])

        Tasks.await(messaging.unsubscribeFromTopic("weather.alerts_v1~us%20"), 5, TimeUnit.SECONDS)
        val unsubOp = recordedOps.last { it["method"] == "messaging.unsubscribeFromTopic" }
        assertEquals("weather.alerts_v1~us%20", unsubOp["topic"])

        val opsBeforeInvalid = recordedOps.size
        for (invalid in listOf("", "/topics/", "bad/slash", "bad space", "bad#hash", "a".repeat(901))) {
            val err = assertThrows(ExecutionException::class.java) {
                Tasks.await(messaging.subscribeToTopic(invalid), 5, TimeUnit.SECONDS)
            }
            assertTrue(err.cause is IllegalArgumentException, "Expected IllegalArgumentException for '$invalid'")
        }
        assertEquals(opsBeforeInvalid, recordedOps.size)

        val brokerFailure = assertThrows(ExecutionException::class.java) {
            Tasks.await(messaging.subscribeToTopic("force-broker-failure"), 5, TimeUnit.SECONDS)
        }
        assertTrue(brokerFailure.cause is IOException)
    }

    @Test
    fun `RemoteMessage builder KTX DSL send callbacks and SendException error codes`() {
        assertEquals(SendException.ERROR_UNKNOWN, SendException(null).errorCode)
        assertEquals(SendException.ERROR_INVALID_PARAMETERS, SendException("invalid_parameters").errorCode)
        assertEquals(SendException.ERROR_INVALID_PARAMETERS, SendException("missing_to").errorCode)
        assertEquals(SendException.ERROR_SIZE, SendException("messagetoobig").errorCode)
        assertEquals(SendException.ERROR_TTL_EXCEEDED, SendException("service_not_available").errorCode)
        assertEquals(SendException.ERROR_TOO_MANY_MESSAGES, SendException("toomanymessages").errorCode)

        val rawInput = byteArrayOf(1, 2, 3, 4)
        val built = remoteMessage("recipient-token:abc") {
            messageId = "msg-42"
            messageType = "chat"
            collapseKey = "thread-7"
            ttl = 120
            addData("k1", "v1")
            addData("k2", "v2")
            setRawData(rawInput)
            setNotification(
                RemoteMessage.Notification(
                    title = "Hello",
                    body = "World",
                    imageUrl = URI.create("https://example.com/banner.png")
                )
            )
        }
        rawInput[0] = 99
        assertEquals("recipient-token:abc", built.to)
        assertEquals("msg-42", built.messageId)
        assertEquals("chat", built.messageType)
        assertEquals("thread-7", built.collapseKey)
        assertEquals(120, built.ttl)
        assertEquals(mapOf("k1" to "v1", "k2" to "v2"), built.data)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), built.rawData)
        assertEquals("Hello", built.notification?.title)
        assertEquals(URI.create("https://example.com/banner.png"), built.notification?.imageUrl)

        val app = newApp("send-app")
        val messaging = FirebaseMessaging.getInstance(app, bridgeClient)

        // Delivered RemoteMessage has null `to`, so send() throws IllegalArgumentException("Missing 'to'")
        val inboundOnly = RemoteMessage.fromDeliveredPayload(
            mapOf("from" to "999999999999", "messageId" to "in-1", "data" to mapOf("x" to "1"))
        )
        assertThrows(IllegalArgumentException::class.java) {
            messaging.send(inboundOnly)
        }

        val sentLatch = CountDownLatch(1)
        val errorLatch = CountDownLatch(3)
        val sentIds = CopyOnWriteArrayList<String>()
        val sendErrors = CopyOnWriteArrayList<Pair<String, SendException>>()

        messaging.registerService(object : FirebaseMessagingService() {
            override fun onMessageSent(msgId: String) {
                sentIds.add(msgId)
                sentLatch.countDown()
            }

            override fun onSendError(msgId: String, exception: Exception) {
                sendErrors.add(msgId to (exception as SendException))
                errorLatch.countDown()
            }
        })

        messaging.send(built)
        assertTrue(sentLatch.await(5, TimeUnit.SECONDS))
        assertEquals(listOf("msg-42"), sentIds.toList())

        val oversized = remoteMessage("/topics/news") {
            messageId = "err-size"
            addData("payload", "x".repeat(5_000))
        }
        val deadTarget = remoteMessage("dead-token") {
            messageId = "err-dead"
            addData("k", "v")
        }
        val quotaTarget = remoteMessage("quota-token") {
            messageId = "err-quota"
            addData("k", "v")
        }
        messaging.send(oversized)
        messaging.send(deadTarget)
        messaging.send(quotaTarget)
        assertTrue(errorLatch.await(5, TimeUnit.SECONDS))

        val codeById = sendErrors.associate { it.first to it.second.errorCode }
        assertEquals(SendException.ERROR_SIZE, codeById["err-size"])
        assertEquals(SendException.ERROR_INVALID_PARAMETERS, codeById["err-dead"])
        assertEquals(SendException.ERROR_TOO_MANY_MESSAGES, codeById["err-quota"])
    }

    @Test
    fun `foregroundMessages backgroundMessages service delivery and visibility validation`() = runBlocking {
        val app = newApp("receive-app")
        val messaging = FirebaseMessaging.getInstance(app, bridgeClient)

        Tasks.await(messaging.setVisibility(true), 5, TimeUnit.SECONDS)
        assertEquals("visible", recordedOps.last { it["method"] == "messaging.setVisibility" }["state"])

        val invalidVis = assertThrows(ExecutionException::class.java) {
            Tasks.await(messaging.setVisibility("minimized"), 5, TimeUnit.SECONDS)
        }
        assertTrue(invalidVis.cause is IllegalArgumentException)

        val serviceMessages = CopyOnWriteArrayList<RemoteMessage>()
        val serviceReceived = CompletableDeferred<RemoteMessage>()
        val svc = object : FirebaseMessagingService() {
            override fun onMessageReceived(message: RemoteMessage) {
                serviceMessages.add(message)
                serviceReceived.complete(message)
            }
        }
        messaging.registerService(svc)

        val fgDeferred = CompletableDeferred<RemoteMessage>()
        val fgJob = launch {
            fgDeferred.complete(messaging.foregroundMessages.first())
        }

        // Wait until both registerService and fgJob have registered messaging.foreground subscriptions
        withTimeout(5_000) {
            while (synchronized(activeSubs) { activeSubs.values.count { it == "messaging.foreground" } < 2 }) {
                kotlinx.coroutines.delay(10)
            }
        }

        pushSnapToTarget(
            "messaging.foreground",
            mapOf(
                "from" to "999999999999",
                "messageId" to "fg-msg-1",
                "data" to mapOf("orderId" to "ord-99"),
                "notification" to mapOf(
                    "title" to "Order Shipped",
                    "body" to "Arriving tomorrow",
                    "image" to "https://example.com/box.png"
                ),
                "priority" to "high"
            )
        )

        val fgMsg = withTimeout(5_000) { fgDeferred.await() }
        val svcMsg = withTimeout(5_000) { serviceReceived.await() }
        fgJob.cancel()

        assertEquals("999999999999", fgMsg.from)
        assertEquals("999999999999", fgMsg.senderId)
        assertEquals("fg-msg-1", fgMsg.messageId)
        assertEquals(mapOf("orderId" to "ord-99"), fgMsg.data)
        assertEquals("Order Shipped", fgMsg.notification?.title)
        assertEquals("Arriving tomorrow", fgMsg.notification?.body)
        assertEquals(URI.create("https://example.com/box.png"), fgMsg.notification?.imageUrl)
        assertEquals(RemoteMessage.PRIORITY_HIGH, fgMsg.priority)
        assertEquals("fg-msg-1", svcMsg.messageId)

        // Data-only background message carries null notification
        val bgDeferred = CompletableDeferred<RemoteMessage>()
        val bgJob = launch {
            bgDeferred.complete(messaging.backgroundMessages.first())
        }
        withTimeout(5_000) {
            while (synchronized(activeSubs) { activeSubs.values.count { it == "messaging.background" } < 2 }) {
                kotlinx.coroutines.delay(10)
            }
        }
        pushSnapToTarget(
            "messaging.background",
            mapOf(
                "from" to "999999999999",
                "messageId" to "bg-data-only-1",
                "data" to mapOf("sync" to "delta")
            )
        )
        val bgMsg = withTimeout(5_000) { bgDeferred.await() }
        bgJob.cancel()
        assertEquals("bg-data-only-1", bgMsg.messageId)
        assertEquals(mapOf("sync" to "delta"), bgMsg.data)
        assertNull(bgMsg.notification)

        messaging.unregisterService(svc)
    }
}
