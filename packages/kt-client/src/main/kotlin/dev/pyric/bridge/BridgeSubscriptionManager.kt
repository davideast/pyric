package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class BridgeSubscriptionManager internal constructor(
    private val onDenial: ((FirebaseFirestoreException) -> Unit)? = null,
    internal val deliveryQueue: BridgeDeliveryQueue = BridgeDeliveryQueue()
) {
    constructor(onDenial: ((FirebaseFirestoreException) -> Unit)? = null) :
        this(onDenial, BridgeDeliveryQueue())
    private val lock = Any()
    private val subCounter = AtomicLong(0)
    private val activeSubs = LinkedHashMap<String, ActiveSubscription>()
    private val attachEpoch = AtomicLong(0)
    private var inRestore = false
    private var restoreEpoch = 0L

    private class ActiveSubscription(
        val subId: String,
        val creationOrder: Long,
        val payload: Map<String, Any?>,
        val includeMetadataChanges: Boolean,
        val sequenced: Boolean,
        val sequencedChannel: Channel<BridgeSequencedSnapshot>? = null,
        val onValue: ((Any?) -> Unit)? = null,
        val onWireError: ((FirebaseFirestoreException) -> Unit)? = null,
        val onCloseError: ((FirebaseFirestoreException) -> Unit)? = null
    ) {
        @Volatile var active: Boolean = true
        @Volatile var everSent: Boolean = false
        var sentOnEpoch: Long = -1L
        var unsubSent: Boolean = false
        @Volatile var hasValue: Boolean = false
        @Volatile var lastValue: Any? = null
        @Volatile var awaitsRestoredValue: Boolean = false
        /** Latest attach epoch sent on, or [Long.MAX_VALUE] once cancelled/terminal. */
        val sentEpoch = AtomicLong(-1L)
    }

    /**
     * Starts a new attach and holds inline subscription sends until [restoreAll]
     * finishes, preventing newly opened listeners from interleaving ahead of
     * restored listeners (D5).
     */
    fun beginAttach(): Long = synchronized(lock) {
        val next = attachEpoch.incrementAndGet()
        inRestore = true
        restoreEpoch = next
        next
    }

    /** Clears restore mode if an attach is interrupted before [restoreAll] completes. */
    internal fun endRestore() {
        synchronized(lock) {
            inRestore = false
        }
    }

    /** True for exactly one caller per subscription and attach (false once terminal). */
    private fun claimSend(sub: ActiveSubscription, epoch: Long): Boolean {
        while (true) {
            val sent = sub.sentEpoch.get()
            if (sent >= epoch) return false
            if (sub.sentEpoch.compareAndSet(sent, epoch)) return true
        }
    }

    /**
     * Registers a subscription synchronously before returning. When attached (and not
     * mid-restore), sends `worker-sub` on the caller's thread before returning (D7).
     * When [appCheckTokenProvider] is present, runs [CoroutineStart.UNDISPATCHED] so
     * registration remains synchronous whenever no async App Check RPC is needed.
     */
    internal fun openSubscription(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        appCheckTokenProvider: (suspend () -> String?)? = null,
        scope: CoroutineScope? = null,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String,
        onValue: (Any?) -> Unit,
        onWireError: (FirebaseFirestoreException) -> Unit,
        onCloseError: (FirebaseFirestoreException) -> Unit
    ): BridgeSubscriptionHandle {
        val cancelled = AtomicBoolean(false)
        val registered = AtomicReference<ActiveSubscription?>(null)
        val setupJob = AtomicReference<Job?>(null)

        fun registerAndSend(appCheckToken: String?) {
            if (cancelled.get()) return
            val record = registerRecord(
                target = target,
                actAs = actAs,
                includeMetadataChanges = includeMetadataChanges,
                listenSource = listenSource,
                appCheckToken = appCheckToken,
                sequenced = false,
                onValue = onValue,
                onWireError = onWireError,
                onCloseError = onCloseError
            )
            registered.set(record)
            if (cancelled.get()) {
                cancelRecord(record, isAttached, sendJson, jsonSerializer)
                return
            }
            dispatchOrConnect(
                record = record,
                scope = scope,
                isAttached = isAttached,
                ensureConnected = ensureConnected,
                keepsSubscriptionOnConnectFailure = keepsSubscriptionOnConnectFailure,
                sendJson = sendJson,
                jsonSerializer = jsonSerializer
            )
        }

        val actualTarget = unwrapTarget(target)
        val needsAppCheck = appCheckTokenProvider != null &&
            actualTarget != null &&
            !BridgeAppCheckAttachment.isInternalSubscriptionTarget(actualTarget)

        if (needsAppCheck && scope != null) {
            setupJob.set(
                scope.launch(start = CoroutineStart.UNDISPATCHED) {
                    val token = BridgeAppCheckAttachment.resolveForSubscription(actualTarget, appCheckTokenProvider)
                    registerAndSend(token)
                }
            )
        } else {
            registerAndSend(null)
        }

        return object : BridgeSubscriptionHandle {
            override fun cancel() {
                if (!cancelled.compareAndSet(false, true)) return
                setupJob.get()?.cancel()
                registered.get()?.let { cancelRecord(it, isAttached, sendJson, jsonSerializer) }
            }
        }
    }

    internal fun openSequencedSubscription(
        target: Any,
        scope: CoroutineScope?,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): SequencedSubscriptionHandle {
        val channel = Channel<BridgeSequencedSnapshot>(Channel.UNLIMITED)
        val record = registerRecord(
            target = target,
            actAs = null,
            includeMetadataChanges = false,
            listenSource = null,
            appCheckToken = null,
            sequenced = true,
            sequencedChannel = channel,
            onCloseError = { err -> closeAndDrain(channel, err) }
        )
        dispatchOrConnect(
            record = record,
            scope = scope,
            isAttached = isAttached,
            ensureConnected = ensureConnected,
            keepsSubscriptionOnConnectFailure = keepsSubscriptionOnConnectFailure,
            sendJson = sendJson,
            jsonSerializer = jsonSerializer
        )
        val handle = object : BridgeSubscriptionHandle {
            override fun cancel() {
                cancelRecord(record, isAttached, sendJson, jsonSerializer)
                closeAndDrain(channel)
            }
        }
        return SequencedSubscriptionHandle(channel, handle)
    }

    private fun closeAndDrain(channel: Channel<BridgeSequencedSnapshot>, cause: Throwable? = null) {
        channel.close(cause)
        while (channel.tryReceive().isSuccess) {}
    }

    fun subscribe(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        appCheckTokenProvider: (suspend () -> String?)? = null,
        scope: CoroutineScope? = null,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<Any?> = flow {
        val handoff = BridgeFlowHandoff<Any?>()
        val actualTarget = unwrapTarget(target)
        val appCheckToken = if (appCheckTokenProvider != null && actualTarget != null) {
            BridgeAppCheckAttachment.resolveForSubscription(actualTarget, appCheckTokenProvider)
        } else {
            null
        }
        val record = registerRecord(
            target = target,
            actAs = actAs,
            includeMetadataChanges = includeMetadataChanges,
            listenSource = listenSource,
            appCheckToken = appCheckToken,
            sequenced = false,
            onValue = handoff::deliverValue,
            onWireError = handoff::deliverError,
            onCloseError = handoff::failImmediate
        )
        try {
            if (!dispatchInitialSend(record, isAttached, keepsSubscriptionOnConnectFailure, sendJson, jsonSerializer)) {
                ensureConnectedOrFail(record, ensureConnected, keepsSubscriptionOnConnectFailure)
            }
            handoff.collectLoop(this)
        } finally {
            handoff.cancel()
            cancelRecord(record, isAttached, sendJson, jsonSerializer)
        }
    }

    internal fun subscribeSequenced(
        target: Any,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Flow<BridgeSequencedSnapshot> = flow {
        val channel = Channel<BridgeSequencedSnapshot>(Channel.UNLIMITED)
        val closeCause = AtomicReference<Throwable?>(null)
        val record = registerRecord(
            target = target,
            actAs = null,
            includeMetadataChanges = false,
            listenSource = null,
            appCheckToken = null,
            sequenced = true,
            sequencedChannel = channel,
            onCloseError = { err ->
                closeCause.compareAndSet(null, err)
                closeAndDrain(channel, err)
            }
        )
        try {
            if (!dispatchInitialSend(record, isAttached, keepsSubscriptionOnConnectFailure, sendJson, jsonSerializer)) {
                ensureConnectedOrFail(record, ensureConnected, keepsSubscriptionOnConnectFailure)
            }
            for (item in channel) {
                closeCause.get()?.let { throw it }
                emit(item)
            }
            closeCause.get()?.let { throw it }
        } finally {
            cancelRecord(record, isAttached, sendJson, jsonSerializer)
            closeAndDrain(channel)
        }
    }

    private fun unwrapTarget(target: Any): Any? =
        if (target is Map<*, *> && target.containsKey("target") && target.size == 1) {
            target["target"]
        } else {
            target
        }

    private fun registerRecord(
        target: Any,
        actAs: Map<String, Any?>?,
        includeMetadataChanges: Boolean,
        listenSource: String?,
        appCheckToken: String?,
        sequenced: Boolean,
        sequencedChannel: Channel<BridgeSequencedSnapshot>? = null,
        onValue: ((Any?) -> Unit)? = null,
        onWireError: ((FirebaseFirestoreException) -> Unit)? = null,
        onCloseError: ((FirebaseFirestoreException) -> Unit)? = null
    ): ActiveSubscription {
        val order = subCounter.incrementAndGet()
        val subId = "rsub-$order"
        val actualTarget = unwrapTarget(target)
        val subPayload = mutableMapOf<String, Any?>("target" to actualTarget)
        if (actAs != null) subPayload["actAs"] = actAs
        if (includeMetadataChanges) subPayload["includeMetadataChanges"] = true
        if (listenSource != null && listenSource != "defaultSource") {
            subPayload["listenSource"] = listenSource
        }
        if (appCheckToken != null) {
            subPayload["appCheckToken"] = appCheckToken
        }
        val record = ActiveSubscription(
            subId = subId,
            creationOrder = order,
            payload = subPayload,
            includeMetadataChanges = includeMetadataChanges,
            sequenced = sequenced,
            sequencedChannel = sequencedChannel,
            onValue = onValue,
            onWireError = onWireError,
            onCloseError = onCloseError
        )
        synchronized(lock) {
            activeSubs[subId] = record
        }
        return record
    }

    private fun dispatchOrConnect(
        record: ActiveSubscription,
        scope: CoroutineScope?,
        isAttached: () -> Boolean,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ) {
        val handledSynchronously = dispatchInitialSend(
            record = record,
            isAttached = isAttached,
            keepsSubscriptionOnConnectFailure = keepsSubscriptionOnConnectFailure,
            sendJson = sendJson,
            jsonSerializer = jsonSerializer
        )
        if (!handledSynchronously && scope != null) {
            scope.launch {
                ensureConnectedOrFail(record, ensureConnected, keepsSubscriptionOnConnectFailure)
            }
        }
    }

    /**
     * Attempts an immediate synchronous `worker-sub` send when attached and not mid-restore.
     * Returns true if handled (sent, left for restore after refusal, or failed), or false
     * when the caller still needs [ensureConnectedOrFail].
     */
    private fun dispatchInitialSend(
        record: ActiveSubscription,
        isAttached: () -> Boolean,
        keepsSubscriptionOnConnectFailure: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Boolean {
        val restoreRunning = synchronized(lock) { inRestore }
        if (restoreRunning) return true
        if (!isAttached()) return false
        val currentEpoch = synchronized(lock) {
            if (inRestore) return true
            attachEpoch.get()
        }
        try {
            if (claimSend(record, currentEpoch)) {
                sendSubFrame(record, currentEpoch, sendJson, jsonSerializer)
            }
        } catch (e: Throwable) {
            val keepsRefused = e is TransportRefused && keepsSubscriptionOnConnectFailure()
            if (!keepsRefused) {
                val removed = removeAndDeactivate(record)
                if (removed) {
                    val failure = FirebaseFirestoreException(
                        "Failed to dispatch subscription to bridge: ${e.message}",
                        FirebaseFirestoreException.Code.UNAVAILABLE,
                        e
                    )
                    record.onCloseError?.invoke(failure)
                }
            }
        }
        return true
    }

    private suspend fun ensureConnectedOrFail(
        record: ActiveSubscription,
        ensureConnected: suspend () -> Unit,
        keepsSubscriptionOnConnectFailure: () -> Boolean
    ) {
        try {
            ensureConnected()
        } catch (e: Throwable) {
            if (!keepsSubscriptionOnConnectFailure() && removeAndDeactivate(record)) {
                val failure = e as? FirebaseFirestoreException ?: FirebaseFirestoreException(
                    "Failed to connect to Pyric bridge: ${e.message}",
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    e
                )
                record.onCloseError?.invoke(failure)
            }
        }
    }

    private fun sendSubFrame(
        record: ActiveSubscription,
        epoch: Long,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ) {
        if (!record.active) return
        sendJson(jsonSerializer(BridgeProtocol.createWorkerSubFrame(record.subId, record.payload)))
        val sendUnsub = synchronized(lock) {
            record.everSent = true
            record.sentOnEpoch = epoch
            val needsUnsub = !record.active && !record.unsubSent && attachEpoch.get() == epoch
            if (needsUnsub) {
                record.unsubSent = true
            }
            needsUnsub
        }
        if (sendUnsub) {
            try {
                sendJson(jsonSerializer(BridgeProtocol.createWorkerUnsubFrame(record.subId)))
            } catch (_: Throwable) {}
        }
    }

    private fun removeAndDeactivate(record: ActiveSubscription): Boolean = synchronized(lock) {
        record.active = false
        record.sentEpoch.set(Long.MAX_VALUE)
        activeSubs.remove(record.subId, record)
    }

    private fun cancelRecord(
        record: ActiveSubscription,
        isAttached: () -> Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ) {
        val shouldUnsub = synchronized(lock) {
            val wasActive = record.active
            record.active = false
            record.sentEpoch.set(Long.MAX_VALUE)
            activeSubs.remove(record.subId, record)
            val sentOnCurrent = record.sentOnEpoch == attachEpoch.get()
            val needsUnsub = wasActive && !record.unsubSent && sentOnCurrent
            if (needsUnsub) {
                record.unsubSent = true
            }
            needsUnsub
        }
        if (shouldUnsub && isAttached()) {
            try {
                sendJson(jsonSerializer(BridgeProtocol.createWorkerUnsubFrame(record.subId)))
            } catch (_: Throwable) {}
        }
    }

    fun handleWorkerSnap(
        msg: Map<String, Any?>,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String,
        wireSeq: Long = 0L
    ) {
        val subId = msg["subId"] as? String ?: return
        val activeSub = synchronized(lock) { activeSubs[subId] } ?: return
        if (!activeSub.active) return

        val value = msg["value"]
        if (value is Map<*, *> && value.containsKey("__error")) {
            if (!removeAndDeactivate(activeSub)) return
            try {
                sendJson(jsonSerializer(BridgeProtocol.createWorkerUnsubFrame(subId)))
            } catch (_: Throwable) {}

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
            if (activeSub.sequenced) {
                activeSub.sequencedChannel?.close(exception)
            } else {
                deliveryQueue.enqueue { activeSub.onWireError?.invoke(exception) }
            }
            return
        }

        if (activeSub.awaitsRestoredValue) {
            activeSub.awaitsRestoredValue = false
            val unchanged = activeSub.hasValue && activeSub.lastValue == value
            if (unchanged && !activeSub.includeMetadataChanges) return
        }
        activeSub.hasValue = true
        activeSub.lastValue = value
        if (activeSub.sequenced) {
            activeSub.sequencedChannel?.trySend(BridgeSequencedSnapshot(value, wireSeq))
        } else {
            deliveryQueue.enqueue {
                if (activeSub.active) {
                    activeSub.onValue?.invoke(value)
                }
            }
        }
    }

    /**
     * Re-sends every live subscription on the attach [epoch] from [beginAttach] in D5
     * order: previously sent (restored) listeners first in creation order, then
     * subscriptions opened while not attached or while restoring in creation order.
     */
    fun restoreAll(epoch: Long, sendJson: (String) -> Unit, jsonSerializer: (Any?) -> String) {
        try {
            while (true) {
                val batch = synchronized(lock) {
                    if (restoreEpoch != epoch && inRestore) return
                    val pending = activeSubs.values
                        .filter { it.active && it.sentEpoch.get() < epoch }
                        .sortedWith(compareBy<ActiveSubscription>({ if (it.everSent) 0 else 1 }, { it.creationOrder }))
                    if (pending.isEmpty()) {
                        if (restoreEpoch == epoch) inRestore = false
                        return
                    }
                    pending
                }
                for (sub in batch) {
                    if (!sub.active || !claimSend(sub, epoch)) continue
                    sub.awaitsRestoredValue = sub.hasValue
                    try {
                        sendSubFrame(sub, epoch, sendJson, jsonSerializer)
                    } catch (_: Throwable) {
                        // A failed send means the socket is closing; its close re-sends this.
                        return
                    }
                }
            }
        } finally {
            synchronized(lock) {
                if (restoreEpoch == epoch) inRestore = false
            }
        }
    }

    /** Reports a dropped connection to subscriptions that asked for metadata changes. */
    fun reportGap() {
        val snapshot = synchronized(lock) {
            activeSubs.values.filter { it.active && it.includeMetadataChanges && it.hasValue }
        }
        for (sub in snapshot) {
            deliveryQueue.enqueue {
                if (sub.active) {
                    sub.onValue?.invoke(BridgeSubscriptionGap)
                }
            }
        }
    }

    fun failAll(code: FirebaseFirestoreException.Code, message: String, cause: Throwable? = null) {
        val removed = synchronized(lock) {
            inRestore = false
            val list = activeSubs.values.toList()
            activeSubs.clear()
            for (sub in list) {
                sub.active = false
                sub.sentEpoch.set(Long.MAX_VALUE)
            }
            list
        }
        for (sub in removed) {
            val error = FirebaseFirestoreException(message, code, cause)
            sub.onCloseError?.invoke(error)
        }
    }
}
