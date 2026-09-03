package dev.pyric.bridge

/**
 * Minimal abstraction for a bidirectional WebSocket transport.
 */
interface BridgeTransport {
    fun send(text: String): Boolean
    fun close(code: Int, reason: String?): Boolean
    fun setListener(listener: BridgeListener)
}

/**
 * Callbacks for WebSocket lifecycle and frame intake.
 */
interface BridgeListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosing(code: Int, reason: String)
    fun onClosed(code: Int, reason: String)
    fun onFailure(throwable: Throwable)
}

/**
 * Factory for creating [BridgeTransport] instances.
 */
fun interface BridgeTransportFactory {
    fun create(
        url: String,
        headers: Map<String, String>,
        listener: BridgeListener
    ): BridgeTransport
}
