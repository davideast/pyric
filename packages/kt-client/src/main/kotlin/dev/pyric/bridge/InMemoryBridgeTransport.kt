package dev.pyric.bridge

import java.util.concurrent.CopyOnWriteArrayList

class InMemoryBridgeTransport : BridgeTransport {

    private var listener: BridgeListener? = null
    private var serverHandler: ((String) -> Unit)? = null
    val sentMessages = CopyOnWriteArrayList<String>()

    override fun send(text: String): Boolean {
        sentMessages.add(text)
        serverHandler?.invoke(text)
        return true
    }

    override fun close(code: Int, reason: String?): Boolean {
        listener?.onClosed(code, reason ?: "")
        return true
    }

    override fun setListener(listener: BridgeListener) {
        this.listener = listener
    }

    fun onServerReceive(handler: (String) -> Unit) {
        this.serverHandler = handler
    }

    fun sendToClient(text: String) {
        listener?.onMessage(text)
    }

    fun simulateOpen() {
        listener?.onOpen()
    }

    fun simulateFailure(throwable: Throwable) {
        listener?.onFailure(throwable)
    }
}
