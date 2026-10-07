package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * Emitted on a subscription opened with `includeMetadataChanges` when the bridge
 * connection drops after the subscription delivered a value. The listener reports
 * its last snapshot again with `isFromCache` set.
 */
object BridgeSubscriptionGap

class BridgeSubscriptionManager(
    private val onDenial: ((FirebaseFirestoreException) -> Unit)? = null
) {
    private val subCounter = AtomicLong(0)
    /** Counts attaches, so each subscription is sent once per attach. */
    private val attachEpoch = AtomicLong(0)
    private val activeSubs = ConcurrentHashMap<String, ActiveSubscription>()

    private class ActiveSubscription(
        val subId: String,
        val channel: ProducerScope<Any?>,
        val payload: Map<String, Any?>,
        val includeMetadataChanges: Boolean
    ) {
        @Volatile var hasValue: Boolean = false
        @Volatile var lastValue: Any? = null
        @Volatile var awaitsRestoredValue: Boolean = false
        private val sentAttach = AtomicLong(-1)

        /** True for the first caller to send this subscription on [attach]. */
        fun claim(attach: Long): Boolean = sentAttach.getAndSet(attach) != attach
    }

    /**
     * Registers a subscription that lives until the flow is cancelled. It is sent
     * now when [isAttached], and by every later attach through [restoreAll].
     */
    fun subscribe(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<Any?> = callbackFlow {
        val subId = "rsub-${subCounter.incrementAndGet()}"

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

        val record = ActiveSubscription(subId, this, subPayload, includeMetadataChanges)
        // Registered before the attach check, so an attach that completes in between sends it.
        activeSubs[subId] = record

        if (isAttached()) {
            // Read after the attach check: an attach that completed in between has
            // already sent it through restoreAll and claimed its epoch.
            val unsent = record.claim(attachEpoch.get())
            if (unsent) {
                try {
                    sendJson(jsonSerializer(BridgeProtocol.createWorkerSubFrame(subId, subPayload)))
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
            }
        } else {
            try {
                ensureConnected()
            } catch (e: Throwable) {
                if (!keepsSubscriptionOnConnectFailure()) {
                    activeSubs.remove(subId)
                    close(
                        e as? FirebaseFirestoreException ?: FirebaseFirestoreException(
                            "Failed to connect to Pyric bridge: ${e.message}",
                            FirebaseFirestoreException.Code.UNAVAILABLE,
                            e
                        )
                    )
                    return@callbackFlow
                }
            }
        }

        awaitClose {
            if (activeSubs.remove(subId) != null && isAttached()) {
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

        if (activeSub.awaitsRestoredValue) {
            activeSub.awaitsRestoredValue = false
            val unchanged = activeSub.hasValue && activeSub.lastValue == value
            // Production raises a sync-state-only change only to metadata listeners.
            if (unchanged && !activeSub.includeMetadataChanges) return
        }
        activeSub.hasValue = true
        activeSub.lastValue = value
        activeSub.channel.trySend(value)
    }

    /** Re-sends every live subscription on a new attach, with its original subId and payload. */
    fun restoreAll(sendJson: (String) -> Unit, jsonSerializer: (Any?) -> String) {
        val attach = attachEpoch.incrementAndGet()
        for (sub in activeSubs.values) {
            if (!sub.claim(attach)) continue
            sub.awaitsRestoredValue = sub.hasValue
            try {
                sendJson(jsonSerializer(BridgeProtocol.createWorkerSubFrame(sub.subId, sub.payload)))
            } catch (_: Throwable) {
                // A failed send means the socket is closing; its close re-sends this.
            }
        }
    }

    /** Reports a dropped connection to subscriptions that asked for metadata changes. */
    fun reportGap() {
        for (sub in activeSubs.values) {
            if (sub.includeMetadataChanges && sub.hasValue) {
                sub.channel.trySend(BridgeSubscriptionGap)
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
