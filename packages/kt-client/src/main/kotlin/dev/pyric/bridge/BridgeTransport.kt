package dev.pyric.bridge

/**
 * Minimal abstraction for a bidirectional WebSocket transport.
 */
interface BridgeTransport {
    /**
     * Enqueues [text] for transmission and returns without waiting for the network.
     *
     * Returns false only when the frame was not enqueued and will never be
     * transmitted, as OkHttp's `WebSocket.send` does on a closing socket. The
     * client then holds the operation and sends it again after the next attach
     * (ADR-0019, amendment 2026-10-17), so a transport must never return false for
     * a frame it may have written: the host would apply it twice. Returns true once
     * the frame is enqueued. Must not block: a release of held operations waits for
     * every send in progress to return.
     */
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
