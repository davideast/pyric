package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.codecs.JsonCodec
import java.util.concurrent.atomic.AtomicBoolean

internal class BridgeSocketAttemptListener(
    private val listenerGeneration: Int,
    private val usesDirectTransport: Boolean,
    private val currentClientGeneration: () -> Int,
    private val isCurrentGeneration: (Int) -> Boolean,
    private val onFrameHeard: () -> Unit,
    private val sendAttach: () -> Unit,
    private val sendRawJson: (String) -> Unit,
    private val onAttachAck: (attemptGeneration: Int, msg: Map<String, Any?>) -> Unit,
    private val onWorkerRes: (Map<String, Any?>) -> Unit,
    private val onWorkerSnap: (Map<String, Any?>) -> Unit,
    private val onRemoteLens: (AuthLens) -> Unit,
    private val onConnectionLoss: (attemptGeneration: Int, error: FirebaseFirestoreException, closeCode: Int?) -> Unit
) : BridgeListener {

    private fun currentGeneration(): Int = listenerGeneration

    private fun isStale(): Boolean = !isCurrentGeneration(currentGeneration())

    // A supplied transport may still deliver frames through a listener it read
    // before the latest attempt replaced it; its frames belong to the current attempt.
    private fun messageGeneration(): Int =
        if (usesDirectTransport) currentClientGeneration() else listenerGeneration

    @Volatile
    private var opened = false

    @Volatile
    private var transportReady = false

    private val attachSent = AtomicBoolean(false)

    /** Called once the client holds this listener's transport. */
    fun markTransportReady() {
        transportReady = true
        if (opened) sendAttachOnce()
    }

    override fun onOpen() {
        opened = true
        if (transportReady) sendAttachOnce()
    }

    private fun sendAttachOnce() {
        if (isStale() || !attachSent.compareAndSet(false, true)) return
        try {
            sendAttach()
        } catch (e: Throwable) {
            onConnectionLoss(
                currentGeneration(),
                FirebaseFirestoreException(
                    "Failed to send attach frame: ${e.message}",
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    e
                ),
                null
            )
        }
    }

    override fun onMessage(text: String) {
        if (!isCurrentGeneration(messageGeneration())) return
        onFrameHeard()
        val msg = try {
            JsonCodec.decodeMap(text)
        } catch (_: Exception) {
            return
        }

        when (msg["type"] as? String) {
            BridgeProtocol.TYPE_ATTACH_ACK -> handleAttachAck(msg)
            BridgeProtocol.TYPE_PING -> {
                val id = msg["id"] as? String
                if (id != null) {
                    try {
                        sendRawJson(JsonCodec.encodeToString(BridgeProtocol.createPongFrame(id)))
                    } catch (_: Throwable) {}
                }
            }
            BridgeProtocol.TYPE_WORKER_RES -> onWorkerRes(msg)
            BridgeProtocol.TYPE_WORKER_SNAP -> onWorkerSnap(msg)
            BridgeProtocol.TYPE_WORKER_EVENT -> handleWorkerEvent(msg)
        }
    }

    private fun handleAttachAck(msg: Map<String, Any?>) {
        val attemptGeneration = messageGeneration()
        val peerConnected = msg["peerConnected"] == true
        if (!peerConnected) {
            onConnectionLoss(
                attemptGeneration,
                FirebaseFirestoreException(
                    "No browser tab is connected to the sandbox; open pyric sandbox in a browser and retry.",
                    FirebaseFirestoreException.Code.UNAVAILABLE
                ),
                null
            )
            return
        }
        onAttachAck(attemptGeneration, msg)
    }

    private fun handleWorkerEvent(msg: Map<String, Any?>) {
        val eventName = msg["event"] as? String ?: return
        if (eventName == BridgeProtocol.EVENT_REMOTE_LENS) {
            @Suppress("UNCHECKED_CAST")
            val payload = msg["payload"] as? Map<String, Any?>
            @Suppress("UNCHECKED_CAST")
            val lensMap = (payload?.get("lens") ?: msg["lens"]) as? Map<String, Any?>
            if (lensMap != null) {
                val lens = AuthLens.fromMap(lensMap)
                onRemoteLens(lens)
            }
        }
    }

    override fun onClosing(code: Int, reason: String) = onClosed(code, reason)

    override fun onClosed(code: Int, reason: String) {
        onConnectionLoss(
            currentGeneration(),
            FirebaseFirestoreException(
                "Bridge connection closed: $reason ($code)",
                FirebaseFirestoreException.Code.UNAVAILABLE
            ),
            code
        )
    }

    override fun onFailure(throwable: Throwable) {
        onConnectionLoss(
            currentGeneration(),
            FirebaseFirestoreException(
                "Bridge connection failed: ${throwable.message}",
                FirebaseFirestoreException.Code.UNAVAILABLE,
                throwable
            ),
            null
        )
    }
}
