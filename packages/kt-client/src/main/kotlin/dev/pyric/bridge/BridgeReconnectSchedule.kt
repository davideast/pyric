package dev.pyric.bridge

import kotlin.math.min

/**
 * The bridge client's transport state. `INTERRUPTED` covers every reconnect
 * attempt after a drop. `CLOSED` means no reconnect is scheduled.
 */
enum class BridgeConnectionState { CONNECTING, ATTACHED, INTERRUPTED, CLOSED }

/** Sends one worker operation on the connection being restored. */
typealias BridgeRestoreOperation = suspend (method: String, params: Map<String, Any?>) -> Any?

/** Re-establishes the session's Auth user on a replaced bridge host. */
typealias BridgeAuthRestorer = suspend (op: BridgeRestoreOperation) -> Unit

/**
 * The wait in milliseconds before reconnect attempt [attempt] (0-based): 250 ms
 * doubling to a 5 s cap, plus up to 250 ms of jitter, never above 5 s.
 */
fun bridgeReconnectDelayMs(attempt: Int, random: Double = Math.random()): Long {
    val exponent = attempt.coerceIn(0, 10)
    val base = min(5000.0, 250.0 * (1 shl exponent))
    val jitter = random * min(250.0, base / 10.0)
    return min(5000.0, base + jitter).toLong()
}

internal const val BRIDGE_CONNECTION_LOST_MESSAGE =
    "The bridge connection was lost. Requests already sent may have completed; check state before retrying."
internal const val BRIDGE_POLICY_CLOSE_CODE = 1008
internal const val BRIDGE_DISCONNECTED_MESSAGE = "PyricBridgeClient disconnected."
internal const val BRIDGE_HOST_SILENT_MESSAGE =
    "The Pyric bridge sent nothing for 45 seconds, so the connection is treated as lost."
internal const val BRIDGE_AUTH_NOT_RESTORED_MESSAGE =
    "The bridge connection was restored, but the signed-in user could not be restored on the new host. The request was not sent."

internal fun computeBridgeHostHeaders(url: String): Map<String, String> {
    val host = try {
        val uri = java.net.URI(url)
        val portStr = if (uri.port != -1) ":${uri.port}" else ""
        "${uri.host}$portStr"
    } catch (_: Throwable) {
        "127.0.0.1:5174"
    }
    return mapOf("Host" to host)
}
