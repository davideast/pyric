package dev.pyric.bridge

import java.util.concurrent.CopyOnWriteArrayList

class InMemoryBridgeTransport : BridgeTransport {

    private val handlerLock = Any()

    @Volatile
    private var listener: BridgeListener? = null
    private var serverHandler: ((String) -> Unit)? = null
    private val pendingBeforeHandler = ArrayList<String>()
    val sentMessages = CopyOnWriteArrayList<String>()

    override fun send(text: String): Boolean {
        sentMessages.add(text)
        val handler = synchronized(handlerLock) {
            val current = serverHandler
            if (current == null) {
                pendingBeforeHandler.add(text)
            }
            current
        }
        handler?.invoke(text)
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
        val toReplay = synchronized(handlerLock) {
            this.serverHandler = handler
            val buffered = ArrayList(pendingBeforeHandler)
            pendingBeforeHandler.clear()
            buffered
        }
        for (msg in toReplay) {
            handler(msg)
        }
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
