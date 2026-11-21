package com.google.firebase.ai.internal

import dev.pyric.bridge.BridgeListener
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.BridgeTransport
import dev.pyric.bridge.BridgeTransportFactory
import dev.pyric.bridge.OkHttpBridgeTransport
import dev.pyric.bridge.OkHttpBridgeTransportFactory
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Finite coroutine [Flow] adapter over Pyric's `worker-sub` / `worker-snap` / `worker-unsub`
 * AI stream protocol (`target: { service: "ai", op: "streamGenerateContent" }`).
 *
 * Uses a dedicated per-stream [BridgeTransport] session rather than `BridgeSubscriptionManager`
 * because `BridgeSubscriptionManager` wraps its target inside `sub.target` (omitting top-level
 * `model` / `request` / `appCheck` fields required by `inbound-validation/subscription.ts`) and
 * replays infinite listeners across reconnects.
 *
 * Cancellation safety: collecting with `.take(1)` or cancelling the collecting coroutine scope
 * immediately invokes `awaitClose`, which sends `worker-unsub` before gracefully closing the
 * WebSocket so the host cancels its detached stream pump.
 */
internal object AiStreamSubscription {
    private val subCounter = AtomicLong(0)
    private val defaultTransportFactory: BridgeTransportFactory = OkHttpBridgeTransportFactory()

    fun <T> openChunkStream(
        url: String,
        headers: Map<String, String>,
        transportFactory: BridgeTransportFactory? = null,
        model: String,
        request: Map<String, Any?>,
        appCheckClaimProvider: (suspend () -> Map<String, Any?>?)? = null,
        engine: Map<String, Any?>? = null,
        timeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
        parseChunk: (Map<String, Any?>) -> T,
        mapError: (code: String, message: String, aiEnvelope: Map<String, Any?>?, cause: Throwable?) -> Throwable
    ): Flow<T> = callbackFlow<T> {
        val subId = "ai-sub-${subCounter.incrementAndGet()}"
        val opened = AtomicBoolean(false)
        val transportAssigned = AtomicBoolean(false)
        val attachSent = AtomicBoolean(false)
        val attachAcked = AtomicBoolean(false)
        val subSent = AtomicBoolean(false)
        val unsubSent = AtomicBoolean(false)
        val firstSnapReceived = AtomicBoolean(false)
        val terminalReached = AtomicBoolean(false)
        val transportRef = AtomicReference<BridgeTransport?>(null)

        val appCheckClaim = try {
            appCheckClaimProvider?.invoke()
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            val mapped = mapError("APP_CHECK_ERROR", t.message ?: "Failed to obtain App Check token", null, t)
            close(mapped)
            return@callbackFlow
        }

        val effectiveTimeoutMs = timeoutMs.coerceAtLeast(1L)
        val firstResponseTimeoutJob = launch {
            delay(effectiveTimeoutMs)
            if (firstSnapReceived.compareAndSet(false, true) && terminalReached.compareAndSet(false, true)) {
                val timeoutError = mapError(
                    "DEADLINE_EXCEEDED",
                    "The request failed to complete in the allotted time.",
                    null,
                    null
                )
                close(timeoutError)
            }
        }

        fun failStream(
            code: String,
            message: String,
            aiEnvelope: Map<String, Any?>? = null,
            cause: Throwable? = null
        ) {
            if (!terminalReached.compareAndSet(false, true)) return
            firstResponseTimeoutJob.cancel()
            val mapped = mapError(code, message, aiEnvelope, cause)
            close(mapped)
        }

        fun trySendSub() {
            val activeTransport = transportRef.get() ?: return
            if (terminalReached.get() || !attachAcked.get()) return
            if (!subSent.compareAndSet(false, true)) return

            val subPayload = LinkedHashMap<String, Any?>()
            subPayload["target"] = mapOf(
                "service" to "ai",
                "op" to "streamGenerateContent"
            )
            subPayload["model"] = model
            subPayload["request"] = request
            if (engine != null) {
                subPayload["engine"] = engine
            }
            if (appCheckClaim != null) {
                subPayload["appCheck"] = appCheckClaim
                val tokenValue = appCheckClaim["token"] as? String
                if (!tokenValue.isNullOrEmpty()) {
                    subPayload["appCheckToken"] = tokenValue
                }
            }

            try {
                val subJson = JsonCodec.encodeToString(BridgeProtocol.createWorkerSubFrame(subId, subPayload))
                val enqueued = activeTransport.send(subJson)
                if (!enqueued) {
                    failStream("UNAVAILABLE", "Failed to enqueue AI stream subscription frame.")
                }
            } catch (t: Throwable) {
                failStream("UNAVAILABLE", "Failed to send AI stream subscription: ${t.message}", null, t)
            }
        }

        fun trySendAttach() {
            val activeTransport = transportRef.get() ?: return
            if (terminalReached.get()) return
            if (!attachSent.compareAndSet(false, true)) return
            try {
                val attachJson = JsonCodec.encodeToString(BridgeProtocol.createAttachFrame())
                val enqueued = activeTransport.send(attachJson)
                if (!enqueued) {
                    failStream("UNAVAILABLE", "Failed to enqueue attach frame to Pyric bridge.")
                }
            } catch (t: Throwable) {
                failStream("UNAVAILABLE", "Failed to send attach frame: ${t.message}", null, t)
            }
        }

        val listener = object : BridgeListener {
            override fun onOpen() {
                opened.set(true)
                if (transportAssigned.get()) {
                    trySendAttach()
                }
            }

            override fun onMessage(text: String) {
                if (terminalReached.get()) return
                val msg = try {
                    JsonCodec.decodeMap(text)
                } catch (t: Throwable) {
                    failStream("SERIALIZATION_ERROR", "Malformed JSON frame on AI stream: ${t.message}", null, t)
                    return
                }

                when (msg["type"] as? String) {
                    BridgeProtocol.TYPE_ATTACH_ACK -> {
                        val peerConnected = msg["peerConnected"]
                        if (peerConnected == false) {
                            failStream(
                                "UNAVAILABLE",
                                "No sandbox host is connected to the Pyric bridge."
                            )
                            return
                        }
                        attachAcked.set(true)
                        trySendSub()
                    }

                    BridgeProtocol.TYPE_PING -> {
                        val pingId = msg["id"] as? String
                        if (pingId != null) {
                            try {
                                val pongJson = JsonCodec.encodeToString(BridgeProtocol.createPongFrame(pingId))
                                transportRef.get()?.send(pongJson)
                            } catch (_: Throwable) {}
                        }
                    }

                    BridgeProtocol.TYPE_WORKER_SNAP -> {
                        val snapSubId = msg["subId"] as? String
                        if (snapSubId != subId) return
                        firstSnapReceived.set(true)
                        firstResponseTimeoutJob.cancel()

                        @Suppress("UNCHECKED_CAST")
                        val snapValue = msg["value"] as? Map<String, Any?>
                        if (snapValue == null) {
                            failStream("SERIALIZATION_ERROR", "Malformed worker-snap value for AI stream.")
                            return
                        }

                        if (snapValue.containsKey("__error")) {
                            @Suppress("UNCHECKED_CAST")
                            val errorMap = snapValue["__error"] as? Map<String, Any?> ?: emptyMap()
                            val errCode = errorMap["code"] as? String ?: "unknown"
                            val errMsg = errorMap["message"] as? String ?: "AI stream failed"
                            @Suppress("UNCHECKED_CAST")
                            val aiEnvelope = (errorMap["aiEnvelope"] ?: errorMap["envelope"]) as? Map<String, Any?>
                            failStream(errCode, errMsg, aiEnvelope, null)
                            return
                        }

                        if (snapValue["done"] == true) {
                            if (terminalReached.compareAndSet(false, true)) {
                                close()
                            }
                            return
                        }

                        @Suppress("UNCHECKED_CAST")
                        val chunkMap = snapValue["chunk"] as? Map<String, Any?>
                        if (chunkMap == null) {
                            failStream("SERIALIZATION_ERROR", "Missing chunk object in AI worker-snap.")
                            return
                        }

                        val parsed = try {
                            parseChunk(chunkMap)
                        } catch (c: CancellationException) {
                            throw c
                        } catch (validationError: Throwable) {
                            if (terminalReached.compareAndSet(false, true)) {
                                close(validationError)
                            }
                            return
                        }

                        trySend(parsed)
                    }
                }
            }

            override fun onClosing(code: Int, reason: String) {
                onClosed(code, reason)
            }

            override fun onClosed(code: Int, reason: String) {
                if (!terminalReached.get()) {
                    failStream(
                        "UNAVAILABLE",
                        "Pyric bridge closed before AI stream completed: $reason ($code)"
                    )
                }
            }

            override fun onFailure(throwable: Throwable) {
                if (!terminalReached.get()) {
                    failStream(
                        "UNAVAILABLE",
                        "Pyric bridge connection failed during AI stream: ${throwable.message}",
                        null,
                        throwable
                    )
                }
            }
        }

        val factory = transportFactory ?: defaultTransportFactory
        val created = try {
            factory.create(url, headers, listener)
        } catch (c: CancellationException) {
            firstResponseTimeoutJob.cancel()
            throw c
        } catch (t: Throwable) {
            firstResponseTimeoutJob.cancel()
            val mapped = mapError("UNAVAILABLE", "Failed to open AI stream transport: ${t.message}", null, t)
            close(mapped)
            return@callbackFlow
        }

        if (created !is OkHttpBridgeTransport) {
            created.setListener(listener)
        }
        transportRef.set(created)
        transportAssigned.set(true)
        if (opened.get() || created !is OkHttpBridgeTransport) {
            trySendAttach()
            trySendSub()
        }

        awaitClose {
            firstResponseTimeoutJob.cancel()
            terminalReached.set(true)
            val activeTransport = transportRef.get()
            if (activeTransport != null) {
                if (subSent.get() && unsubSent.compareAndSet(false, true)) {
                    try {
                        val unsubJson = JsonCodec.encodeToString(BridgeProtocol.createWorkerUnsubFrame(subId))
                        activeTransport.send(unsubJson)
                    } catch (_: Throwable) {}
                }
                try {
                    activeTransport.close(1000, "AI stream closed")
                } catch (_: Throwable) {}
            }
        }
    }.buffer(Channel.UNLIMITED)
}
