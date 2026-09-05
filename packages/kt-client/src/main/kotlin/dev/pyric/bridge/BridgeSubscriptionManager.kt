package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class BridgeSubscriptionManager(
    private val onDenial: ((FirebaseFirestoreException) -> Unit)? = null
) {
    private val subCounter = AtomicLong(0)
    private val activeSubs = ConcurrentHashMap<String, ActiveSubscription>()

    private data class ActiveSubscription(
        val subId: String,
        val channel: ProducerScope<Any?>,
        val target: Any,
        val actAs: Map<String, Any?>?,
        val includeMetadataChanges: Boolean,
        val listenSource: String?
    )

    fun subscribe(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        ensureConnected: suspend () -> Unit,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<Any?> = callbackFlow {
        ensureConnected()

        val subId = "rsub-${subCounter.incrementAndGet()}"
        val subRecord = ActiveSubscription(
            subId = subId,
            channel = this,
            target = target,
            actAs = actAs,
            includeMetadataChanges = includeMetadataChanges,
            listenSource = listenSource
        )
        activeSubs[subId] = subRecord

        val actualTarget = if (target is Map<*, *> && target.containsKey("target") && target.size == 1) {
            target["target"]
        } else {
            target
        }
        val subPayload = mutableMapOf<String, Any?>("target" to actualTarget)
        if (actAs != null) subPayload["actAs"] = actAs
        if (includeMetadataChanges) subPayload["includeMetadataChanges"] = true
        if (listenSource != null && listenSource != "defaultSource") {
            subPayload["listenSource"] = listenSource
        }

        val frame = BridgeProtocol.createWorkerSubFrame(subId, subPayload)
        try {
            sendJson(jsonSerializer(frame))
        } catch (e: Throwable) {
            activeSubs.remove(subId)
            close(
                FirebaseFirestoreException(
                    "Failed to dispatch subscription to bridge: ${e.message}",
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    e
                )
            )
            return@callbackFlow
        }

        awaitClose {
            if (activeSubs.remove(subId) != null) {
                try {
                    val unsubFrame = BridgeProtocol.createWorkerUnsubFrame(subId)
                    sendJson(jsonSerializer(unsubFrame))
                } catch (_: Throwable) {
                    // Ignored on teardown
                }
            }
        }
    }

    fun handleWorkerSnap(
        msg: Map<String, Any?>,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ) {
        val subId = msg["subId"] as? String ?: return
        val activeSub = activeSubs[subId] ?: return

        val value = msg["value"]
        if (value is Map<*, *> && value.containsKey("__error")) {
            // Terminal error condition
            activeSubs.remove(subId)

            try {
                val unsubFrame = BridgeProtocol.createWorkerUnsubFrame(subId)
                sendJson(jsonSerializer(unsubFrame))
            } catch (_: Throwable) {
                // Best effort unregister
            }

            @Suppress("UNCHECKED_CAST")
            val errorMap = value["__error"] as? Map<String, Any?> ?: emptyMap()
            val codeStr = errorMap["code"] as? String ?: "permission-denied"
            val messageStr = errorMap["message"] as? String ?: "Subscription error"
            val denialContext = errorMap["denialContext"]

            val firestoreCode = FirebaseFirestoreException.Code.fromWireCode(codeStr)
            val exception = FirebaseFirestoreException(
                messageStr,
                firestoreCode,
                denialContext = denialContext
            )
            if (firestoreCode == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                onDenial?.invoke(exception)
            }

            activeSub.channel.close(exception)
            return
        }

        activeSub.channel.trySend(value)
    }

    fun resubscribeAll(sendJson: (String) -> Unit, jsonSerializer: (Any?) -> String) {
        for (sub in activeSubs.values) {
            val actualTarget = if (sub.target is Map<*, *> && (sub.target as Map<*, *>).containsKey("target") && (sub.target as Map<*, *>).size == 1) {
                (sub.target as Map<*, *>)["target"]
            } else {
                sub.target
            }
            val subPayload = mutableMapOf<String, Any?>("target" to actualTarget)
            if (sub.actAs != null) subPayload["actAs"] = sub.actAs
            if (sub.includeMetadataChanges) subPayload["includeMetadataChanges"] = true
            if (sub.listenSource != null && sub.listenSource != "defaultSource") {
                subPayload["listenSource"] = sub.listenSource
            }

            val frame = BridgeProtocol.createWorkerSubFrame(sub.subId, subPayload)
            try {
                sendJson(jsonSerializer(frame))
            } catch (_: Throwable) {
                // Ignored
            }
        }
    }

    fun failAll(code: FirebaseFirestoreException.Code, message: String, cause: Throwable? = null) {
        val iterator = activeSubs.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            iterator.remove()
            entry.value.channel.close(
                FirebaseFirestoreException(message, code, cause)
            )
        }
    }
}
