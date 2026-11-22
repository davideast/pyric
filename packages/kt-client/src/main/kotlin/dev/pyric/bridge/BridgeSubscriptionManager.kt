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

internal data class BridgeSequencedSnapshot(
    val value: Any?,
    val wireSeq: Long
)

class BridgeSubscriptionManager(
    private val onDenial: ((FirebaseFirestoreException) -> Unit)? = null
) {
    private val subCounter = AtomicLong(0)
    private val activeSubs = ConcurrentHashMap<String, ActiveSubscription>()
    private val attachEpoch = AtomicLong(0)

    private class ActiveSubscription(
        val subId: String,
        val channel: ProducerScope<Any?>,
        val payload: Map<String, Any?>,
        val includeMetadataChanges: Boolean,
        val sequenced: Boolean = false
    ) {
        @Volatile var hasValue: Boolean = false
        @Volatile var lastValue: Any? = null
        @Volatile var awaitsRestoredValue: Boolean = false
        /** The latest attach this subscription was sent on. */
        val sentEpoch = AtomicLong(0)
    }

    /**
     * Starts a new attach. The client calls this before it reports itself attached,
     * so a subscription that sees the attach also sees its epoch.
     */
    fun beginAttach(): Long = attachEpoch.incrementAndGet()

    /** True for exactly one caller per subscription and attach. */
    private fun claimSend(sub: ActiveSubscription, epoch: Long): Boolean {
        while (true) {
            val sent = sub.sentEpoch.get()
            if (sent >= epoch) return false
            if (sub.sentEpoch.compareAndSet(sent, epoch)) return true
        }
    }

    /**
     * Registers a subscription that lives until the flow is cancelled. It is sent
     * now when [isAttached], and by every later attach through [restoreAll]. When an
     * attach completes between registration and the attach check, only one of the
     * two sends it. A frame the transport refused is left to the next attach while
     * [keepsSubscriptionOnConnectFailure] holds.
     */
    fun subscribe(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        appCheckTokenProvider: (suspend () -> String?)? = null,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<Any?> = openSubscription(
        target = target,
        actAs = actAs,
        includeMetadataChanges = includeMetadataChanges,
        listenSource = listenSource,
        appCheckTokenProvider = appCheckTokenProvider,
        sequenced = false,
        isAttached = isAttached,
        ensureConnected = ensureConnected,
        keepsSubscriptionOnConnectFailure = keepsSubscriptionOnConnectFailure,
        sendJson = sendJson,
        jsonSerializer = jsonSerializer
    )

    internal fun subscribeSequenced(
        target: Any,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<BridgeSequencedSnapshot> = kotlinx.coroutines.flow.flow {
        openSubscription(
            target = target,
            actAs = null,
            includeMetadataChanges = false,
            listenSource = null,
            appCheckTokenProvider = null,
            sequenced = true,
            isAttached = isAttached,
            ensureConnected = ensureConnected,
            keepsSubscriptionOnConnectFailure = keepsSubscriptionOnConnectFailure,
            sendJson = sendJson,
            jsonSerializer = jsonSerializer
        ).collect { item ->
            if (item is BridgeSequencedSnapshot) {
                emit(item)
            }
        }
    }

    private fun openSubscription(
        target: Any,
        actAs: Map<String, Any?>?,
        includeMetadataChanges: Boolean,
        listenSource: String?,
        appCheckTokenProvider: (suspend () -> String?)?,
        sequenced: Boolean,
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
        val appCheckToken = if (actualTarget != null) {
            BridgeAppCheckAttachment.resolveForSubscription(actualTarget, appCheckTokenProvider)
        } else {
            null
        }
        if (appCheckToken != null) {
            subPayload["appCheckToken"] = appCheckToken
        }

        val record = ActiveSubscription(subId, this, subPayload, includeMetadataChanges, sequenced)
        // Registered before the attach check, so an attach that completes in between sends it.
        activeSubs[subId] = record

        if (isAttached()) {
            try {
                if (claimSend(record, attachEpoch.get())) {
                    sendJson(jsonSerializer(BridgeProtocol.createWorkerSubFrame(subId, subPayload)))
                }
            } catch (e: Throwable) {
                // A refused frame never left the device; the next attach's restore sends it.
                val keepsRefused = e is TransportRefused && keepsSubscriptionOnConnectFailure()
                if (!keepsRefused) {
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
        jsonSerializer: (Any?) -> String,
        wireSeq: Long = 0L
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
        val emitted = if (activeSub.sequenced) BridgeSequencedSnapshot(value, wireSeq) else value
        activeSub.channel.trySend(emitted)
    }

    /**
     * Re-sends every live subscription on the attach [epoch] from [beginAttach], with
     * its original subId and payload. A subscription already sent on this attach is skipped.
     */
    fun restoreAll(epoch: Long, sendJson: (String) -> Unit, jsonSerializer: (Any?) -> String) {
        for (sub in activeSubs.values) {
            if (!claimSend(sub, epoch)) continue
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
