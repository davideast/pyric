package dev.pyric.ai

import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingDeque

internal data class RecordedAiOp(
    val id: String,
    val method: String,
    val op: Map<String, Any?>
)

internal sealed interface ScriptedBridgeReply {
    data class Success(val value: Any?) : ScriptedBridgeReply
    data class Failure(val code: String, val message: String) : ScriptedBridgeReply
    data object HoldNeverReply : ScriptedBridgeReply
}

internal class AiMockBridgeHarness(
    defaultOpTimeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS
) {
    val transport = InMemoryBridgeTransport()
    val recordedOps = CopyOnWriteArrayList<RecordedAiOp>()
    private val replyQueue = LinkedBlockingDeque<ScriptedBridgeReply>()
    private var dynamicResponder: ((RecordedAiOp) -> ScriptedBridgeReply)? = null

    val client: PyricBridgeClient

    init {
        transport.onServerReceive { rawJson ->
            val decoded = JsonCodec.decodeMap(rawJson)
            when (decoded["type"]) {
                BridgeProtocol.TYPE_ATTACH -> {
                    transport.sendToClient(
                        JsonCodec.encodeToString(
                            mapOf(
                                "type" to BridgeProtocol.TYPE_ATTACH_ACK,
                                "protocol" to 1,
                                "clientSessionId" to "mock-ai-session",
                                "peerConnected" to true,
                                "hostInstanceId" to "mock-ai-host-1"
                            )
                        )
                    )
                }
                BridgeProtocol.TYPE_PING -> {
                    val pingId = decoded["id"] as? String ?: "ping-0"
                    transport.sendToClient(
                        JsonCodec.encodeToString(BridgeProtocol.createPongFrame(pingId))
                    )
                }
                BridgeProtocol.TYPE_WORKER_OP -> {
                    val id = decoded["id"] as? String ?: return@onServerReceive
                    @Suppress("UNCHECKED_CAST")
                    val opMap = (decoded["op"] as? Map<String, Any?>).orEmpty()
                    val method = opMap["method"] as? String ?: ""
                    val recorded = RecordedAiOp(id = id, method = method, op = opMap)
                    recordedOps.add(recorded)

                    val scripted = replyQueue.pollFirst()
                        ?: dynamicResponder?.invoke(recorded)
                        ?: ScriptedBridgeReply.Failure(
                            code = "ai/INTERNAL",
                            message = "No scripted reply queued for $method"
                        )
                    when (scripted) {
                        is ScriptedBridgeReply.Success -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to BridgeProtocol.TYPE_WORKER_RES,
                                        "id" to id,
                                        "ok" to true,
                                        "value" to scripted.value
                                    )
                                )
                            )
                        }
                        is ScriptedBridgeReply.Failure -> {
                            transport.sendToClient(
                                JsonCodec.encodeToString(
                                    mapOf(
                                        "type" to BridgeProtocol.TYPE_WORKER_RES,
                                        "id" to id,
                                        "ok" to false,
                                        "error" to mapOf(
                                            "code" to scripted.code,
                                            "message" to scripted.message
                                        )
                                    )
                                )
                            )
                        }
                        ScriptedBridgeReply.HoldNeverReply -> Unit
                    }
                }
            }
        }
        client = PyricBridgeClient(
            url = BridgeProtocol.DEFAULT_BRIDGE_URL,
            headers = emptyMap(),
            defaultOpTimeoutMs = defaultOpTimeoutMs,
            directTransport = transport
        )
    }

    fun enqueueSuccess(value: Any?) {
        replyQueue.addLast(ScriptedBridgeReply.Success(value))
    }

    fun enqueueFailure(code: String, message: String) {
        replyQueue.addLast(ScriptedBridgeReply.Failure(code, message))
    }

    fun enqueueHold() {
        replyQueue.addLast(ScriptedBridgeReply.HoldNeverReply)
    }

    fun onOp(responder: (RecordedAiOp) -> ScriptedBridgeReply) {
        dynamicResponder = responder
    }

    fun close() {
        client.terminate()
    }
}
