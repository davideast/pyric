package dev.pyric.bridge

object BridgeProtocol {
    const val PROTOCOL_VERSION: Int = 1
    const val DEFAULT_BRIDGE_URL: String = "ws://127.0.0.1:5174/__pyric/sandbox"
    const val DEFAULT_OP_TIMEOUT_MS: Long = 35_000L

    const val TYPE_ATTACH = "attach"
    const val TYPE_ATTACH_ACK = "attach-ack"
    const val TYPE_WORKER_OP = "worker-op"
    const val TYPE_WORKER_RES = "worker-res"
    const val TYPE_WORKER_SUB = "worker-sub"
    const val TYPE_WORKER_SNAP = "worker-snap"
    const val TYPE_WORKER_UNSUB = "worker-unsub"
    const val TYPE_PING = "ping"
    const val TYPE_PONG = "pong"
    const val TYPE_WORKER_EVENT = "worker-event"
    const val EVENT_REMOTE_LENS = "remote-lens"

    fun createAttachFrame(): Map<String, Any> = mapOf(
        "type" to TYPE_ATTACH,
        "protocol" to PROTOCOL_VERSION
    )

    fun createPongFrame(id: String): Map<String, Any> = mapOf(
        "type" to TYPE_PONG,
        "id" to id
    )

    fun createWorkerOpFrame(id: String, op: Map<String, Any?>): Map<String, Any?> = mapOf(
        "type" to TYPE_WORKER_OP,
        "id" to id,
        "op" to op
    )

    fun createWorkerSubFrame(subId: String, sub: Map<String, Any?>): Map<String, Any?> = mapOf(
        "type" to TYPE_WORKER_SUB,
        "subId" to subId,
        "sub" to sub
    )

    fun createWorkerUnsubFrame(subId: String): Map<String, Any> = mapOf(
        "type" to TYPE_WORKER_UNSUB,
        "subId" to subId
    )
}
