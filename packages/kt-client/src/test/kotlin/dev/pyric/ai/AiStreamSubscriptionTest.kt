package dev.pyric.ai

import com.google.firebase.ai.internal.AiStreamSubscription
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.BridgeTransportFactory
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class AiStreamSubscriptionTest {

    private class TestStreamException(
        val code: String,
        override val message: String,
        val aiEnvelope: Map<String, Any?>? = null
    ) : RuntimeException(message)

    @Test
    fun streamsOrderedChunksAttachesAppCheckAndCompletesOnDoneSnap() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val observedSubPayload = AtomicReference<Map<String, Any?>>()

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf("type" to BridgeProtocol.TYPE_ATTACH_ACK, "protocol" to 1, "peerConnected" to true)
                        )
                    )
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = frame["subId"] as String
                    @Suppress("UNCHECKED_CAST")
                    val sub = frame["sub"] as Map<String, Any?>
                    observedSubPayload.set(sub)

                    for (piece in listOf("Hel", "lo ", "Pyric")) {
                        val snap = mapOf(
                            "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                            "subId" to subId,
                            "value" to mapOf("chunk" to mapOf("piece" to piece))
                        )
                        transport.sendToClient(JsonCodec.encodeToString(snap))
                    }
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                                "subId" to subId,
                                "value" to mapOf("done" to true)
                            )
                        )
                    )
                }
            }
        }

        val chunks = AiStreamSubscription.openChunkStream(
            url = "ws://127.0.0.1:0/__pyric/sandbox",
            headers = emptyMap(),
            transportFactory = BridgeTransportFactory { _, _, _ -> transport },
            model = "models/gemini-2.5-flash",
            request = mapOf("contents" to listOf(mapOf("role" to "user", "parts" to listOf(mapOf("text" to "hi"))))),
            appCheckClaimProvider = { mapOf("token" to "jwt-token-123") },
            parseChunk = { it["piece"] as String },
            mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
        ).toList()

        assertEquals(listOf("Hel", "lo ", "Pyric"), chunks)
        val sub = observedSubPayload.get()
        assertNotNull(sub)
        assertEquals(mapOf("service" to "ai", "op" to "streamGenerateContent"), sub["target"])
        assertEquals("models/gemini-2.5-flash", sub["model"])
        assertEquals(mapOf("token" to "jwt-token-123"), sub["appCheck"])
        assertEquals("jwt-token-123", sub["appCheckToken"])
    }

    @Test
    fun takeOneEarlyCancellationSendsWorkerUnsubImmediately() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val unsubObserved = AtomicBoolean(false)
        val activeSubId = AtomicReference<String>()

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient(
                        """{"type":"attach-ack","protocol":1,"peerConnected":true}"""
                    )
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = frame["subId"] as String
                    activeSubId.set(subId)
                    // Emit first chunk only; stream stays open waiting for more chunks.
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                                "subId" to subId,
                                "value" to mapOf("chunk" to mapOf("piece" to "first-only"))
                            )
                        )
                    )
                }
                BridgeProtocol.TYPE_WORKER_UNSUB -> {
                    if (frame["subId"] == activeSubId.get()) {
                        unsubObserved.set(true)
                    }
                }
            }
        }

        val collected = AiStreamSubscription.openChunkStream(
            url = "ws://127.0.0.1:0/__pyric/sandbox",
            headers = emptyMap(),
            transportFactory = BridgeTransportFactory { _, _, _ -> transport },
            model = "models/gemini-2.5-flash",
            request = mapOf("contents" to emptyList<Any>()),
            parseChunk = { it["piece"] as String },
            mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
        ).take(1).toList()

        assertEquals(listOf("first-only"), collected)
        assertTrue(unsubObserved.get(), "Expected worker-unsub frame on .take(1) cancellation")
    }

    @Test
    fun scopeCancellationMidStreamSendsWorkerUnsubAndAnswersPingWithPong() = runBlocking {
        val transport = InMemoryBridgeTransport()
        val unsubObserved = AtomicBoolean(false)
        val pongObserved = AtomicBoolean(false)
        val firstChunkDelivered = CompletableDeferred<Unit>()
        val subscribedSubId = AtomicReference<String>()

        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = frame["subId"] as String
                    subscribedSubId.set(subId)
                    transport.sendToClient("""{"type":"ping","id":"hb-1"}""")
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                                "subId" to subId,
                                "value" to mapOf("chunk" to mapOf("piece" to "chunk-1"))
                            )
                        )
                    )
                }
                BridgeProtocol.TYPE_PONG -> {
                    if (frame["id"] == "hb-1") pongObserved.set(true)
                }
                BridgeProtocol.TYPE_WORKER_UNSUB -> {
                    if (frame["subId"] == subscribedSubId.get()) unsubObserved.set(true)
                }
            }
        }

        val job = launch {
            try {
                AiStreamSubscription.openChunkStream(
                    url = "ws://127.0.0.1:0/__pyric/sandbox",
                    headers = emptyMap(),
                    transportFactory = BridgeTransportFactory { _, _, _ -> transport },
                    model = "models/gemini-2.5-flash",
                    request = mapOf("contents" to emptyList<Any>()),
                    parseChunk = { it["piece"] as String },
                    mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
                ).collect {
                    firstChunkDelivered.complete(Unit)
                }
            } catch (c: CancellationException) {
                throw c
            }
        }

        firstChunkDelivered.await()
        job.cancelAndJoin()

        assertTrue(pongObserved.get(), "Expected pong reply during active AI stream")
        assertTrue(unsubObserved.get(), "Expected worker-unsub frame on coroutine scope cancel")
    }

    @Test
    fun errorSnapPropagatesCodeMessageAndAiEnvelopeToErrorMapper() {
        val transport = InMemoryBridgeTransport()
        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = frame["subId"] as String
                    val errSnap = mapOf(
                        "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                        "subId" to subId,
                        "value" to mapOf(
                            "__error" to mapOf(
                                "code" to "ai/RESOURCE_EXHAUSTED",
                                "message" to "Quota exceeded for gemini-2.5-flash",
                                "aiEnvelope" to mapOf(
                                    "error" to mapOf(
                                        "code" to 429,
                                        "status" to "RESOURCE_EXHAUSTED",
                                        "message" to "Quota exceeded for gemini-2.5-flash"
                                    )
                                )
                            )
                        )
                    )
                    transport.sendToClient(JsonCodec.encodeToString(errSnap))
                }
            }
        }

        val thrown = assertThrows<TestStreamException> {
            runBlocking {
                AiStreamSubscription.openChunkStream(
                    url = "ws://127.0.0.1:0/__pyric/sandbox",
                    headers = emptyMap(),
                    transportFactory = BridgeTransportFactory { _, _, _ -> transport },
                    model = "models/gemini-2.5-flash",
                    request = mapOf("contents" to emptyList<Any>()),
                    parseChunk = { it },
                    mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
                ).collect()
            }
        }
        assertEquals("ai/RESOURCE_EXHAUSTED", thrown.code)
        assertTrue(thrown.message.contains("Quota exceeded"))
        assertNotNull(thrown.aiEnvelope)
    }

    @Test
    fun firstResponseTimeoutAndPrematureClosePropagateMappedErrorsAndUnsubscribe() {
        val silentTransport = InMemoryBridgeTransport()
        val unsubOnTimeout = AtomicBoolean(false)
        silentTransport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    silentTransport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                BridgeProtocol.TYPE_WORKER_UNSUB -> {
                    unsubOnTimeout.set(true)
                }
            }
        }

        val timeoutErr = assertThrows<TestStreamException> {
            runBlocking {
                AiStreamSubscription.openChunkStream(
                    url = "ws://127.0.0.1:0/__pyric/sandbox",
                    headers = emptyMap(),
                    transportFactory = BridgeTransportFactory { _, _, _ -> silentTransport },
                    model = "models/gemini-2.5-flash",
                    request = mapOf("contents" to emptyList<Any>()),
                    timeoutMs = 30L,
                    parseChunk = { it },
                    mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
                ).collect()
            }
        }
        assertEquals("DEADLINE_EXCEEDED", timeoutErr.code)
        assertTrue(unsubOnTimeout.get(), "Expected worker-unsub on first-response timeout")

        val droppingTransport = InMemoryBridgeTransport()
        droppingTransport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            if (frame["type"] == BridgeProtocol.TYPE_ATTACH) {
                droppingTransport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            } else if (frame["type"] == BridgeProtocol.TYPE_WORKER_SUB) {
                droppingTransport.simulateFailure(IllegalStateException("socket reset"))
            }
        }

        val dropErr = assertThrows<TestStreamException> {
            runBlocking {
                AiStreamSubscription.openChunkStream(
                    url = "ws://127.0.0.1:0/__pyric/sandbox",
                    headers = emptyMap(),
                    transportFactory = BridgeTransportFactory { _, _, _ -> droppingTransport },
                    model = "models/gemini-2.5-flash",
                    request = mapOf("contents" to emptyList<Any>()),
                    parseChunk = { it },
                    mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
                ).collect()
            }
        }
        assertEquals("UNAVAILABLE", dropErr.code)
        assertTrue(dropErr.message.contains("socket reset"))
    }

    @Test
    fun chunkValidationExceptionTerminatesStreamImmediatelyAndUnsubscribes() {
        class BlockedChunkException(message: String) : RuntimeException(message)

        val transport = InMemoryBridgeTransport()
        val unsubObserved = AtomicBoolean(false)
        transport.onServerReceive { raw ->
            val frame = JsonCodec.decodeMap(raw)
            when (frame["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                BridgeProtocol.TYPE_WORKER_SUB -> {
                    val subId = frame["subId"] as String
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_WORKER_SNAP,
                                "subId" to subId,
                                "value" to mapOf("chunk" to mapOf("finishReason" to "SAFETY"))
                            )
                        )
                    )
                }
                BridgeProtocol.TYPE_WORKER_UNSUB -> {
                    unsubObserved.set(true)
                }
            }
        }

        assertThrows<BlockedChunkException> {
            runBlocking {
                AiStreamSubscription.openChunkStream(
                    url = "ws://127.0.0.1:0/__pyric/sandbox",
                    headers = emptyMap(),
                    transportFactory = BridgeTransportFactory { _, _, _ -> transport },
                    model = "models/gemini-2.5-flash",
                    request = mapOf("contents" to emptyList<Any>()),
                    parseChunk = { chunk ->
                        if (chunk["finishReason"] == "SAFETY") {
                            throw BlockedChunkException("Candidate stopped due to SAFETY")
                        }
                        chunk
                    },
                    mapError = { code, message, env, _ -> TestStreamException(code, message, env) }
                ).collect()
            }
        }
        assertTrue(unsubObserved.get(), "Expected worker-unsub when chunk validation aborts stream")
    }
}
