package dev.pyric.bridge

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicLong

/**
 * WebSocket transport to the Pyric bridge with bounded reconnect backoff,
 * session re-attach + subscription replay, held pre-attach operations (10s),
 * and 15s/45s liveness heartbeats (ADR-0019).
 */
class PyricBridgeClient(
    val url: String = BridgeProtocol.DEFAULT_BRIDGE_URL,
    val headers: Map<String, String> = defaultHeaders(url),
    val defaultOpTimeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
    private val transportFactory: BridgeTransportFactory? = null,
    private val directTransport: BridgeTransport? = null,
    /** Retry the first connection on the reconnect schedule instead of failing. */
    val retryInitialConnection: Boolean = false,
    private val reconnectDelayMs: (Int) -> Long = { bridgeReconnectDelayMs(it) },
    /** An attempt that has not attached within this time counts as failed. */
    private val attachTimeoutMs: Long = 5_000L
) {
    private val clientScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Any()

    @Volatile
    private var transport: BridgeTransport? = directTransport
    private var handshake: CompletableDeferred<Boolean>? = null
    private var attempt: CompletableDeferred<Unit>? = null
    private var generation = 0
    @Volatile
    private var hasEverAttached = false
    private var hostInstanceId: String? = null
    /**
     * Set when an attach acknowledgement shows a replaced host. Cleared only when
     * an attach that ran the Auth restore completes, so a drop during the restore
     * leaves it set and the next attach to that host restores again.
     */
    private var needsAuthRestore = false
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null
    private var attachDeadlineJob: Job? = null
    /** Callers waiting for the next scheduled attempt. */
    private var nextAttempt: CompletableDeferred<Unit>? = null

    /** Test seam: hold deadline (fixed at 10s per ADR-0019 decision 7). */
    internal var holdTimeoutMs: Long = BRIDGE_HOLD_TIMEOUT_MS

    /** Test seams: ping interval (15s) and silence timeout (45s) per ADR-0019; applies on next attach. */
    @Volatile internal var heartbeatIntervalMs: Long = BRIDGE_HEARTBEAT_INTERVAL_MS
    @Volatile internal var livenessTimeoutMs: Long = BRIDGE_LIVENESS_TIMEOUT_MS

    /** Runs on re-attach to a replaced host before subscriptions replay; failure fails held ops. */
    @Volatile var restoreAuth: BridgeAuthRestorer = {}

    /** Resolves the active App Check token for requests on the owning FirebaseApp. */
    @Volatile internal var appCheckTokenProvider: (suspend () -> String?)? = null

    /** The client session ID acknowledged by the bridge. */
    @Volatile var clientSessionId: String? = null
        private set

    internal val deliveryQueue = BridgeDeliveryQueue()
    private val eventHub = BridgeEventHub(deliveryQueue)

    private val _connectionStateFlow = MutableStateFlow(false)
    val connectionStateFlow: StateFlow<Boolean> = _connectionStateFlow.asStateFlow()

    val connectionStates: StateFlow<BridgeConnectionState> get() = eventHub.connectionStates

    val connectionState: BridgeConnectionState get() = eventHub.connectionState

    @Volatile
    var isConnected: Boolean = false
        private set(value) {
            field = value
            _connectionStateFlow.value = value
        }

    @Volatile
    var isDisposed: Boolean = false
        private set

    val remoteLensEvents: SharedFlow<AuthLens> get() = eventHub.remoteLensEvents

    val denialEvents: SharedFlow<FirebaseFirestoreException> get() = eventHub.denialEvents

    internal fun dispatchDenial(exception: FirebaseFirestoreException) = eventHub.dispatchDenial(exception)
    internal fun addConnectionStateObserver(observer: BridgeConnectionObserver): () -> Unit = eventHub.addConnectionStateObserver(observer)
    internal fun addRemoteLensObserver(observer: (AuthLens) -> Unit): () -> Unit = eventHub.addRemoteLensObserver(observer)
    internal fun addDenialObserver(observer: (FirebaseFirestoreException) -> Unit): () -> Unit = eventHub.addDenialObserver(observer)

    private val operationDispatcher = BridgeOperationDispatcher(clientScope, defaultOpTimeoutMs, onDenial = ::dispatchDenial)
    private val subscriptionManager = BridgeSubscriptionManager(onDenial = ::dispatchDenial, deliveryQueue = deliveryQueue)
    private val heldOperations = BridgeHeldOperations(clientScope)
    private val heartbeat = BridgeHeartbeat(clientScope)
    private val pingCounter = AtomicLong(0)
    private val inboundWireSeq = AtomicLong(0)

    internal fun currentInboundWireSeq(): Long = inboundWireSeq.get()

    private val canReopen: Boolean get() = directTransport == null

    constructor(transport: BridgeTransport) : this(
        url = BridgeProtocol.DEFAULT_BRIDGE_URL,
        headers = emptyMap(),
        defaultOpTimeoutMs = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
        transportFactory = null,
        directTransport = transport
    )

    init {
        directTransport?.setListener(newAttemptListener(0))
        // Started here rather than from a launched connect(): a launch can run after
        // this attempt failed and closed the client, and would reopen it (D6).
        synchronized(lock) { startAttemptLocked() }
    }

    /**
     * Establishes the WebSocket connection and completes the attach / attach-ack
     * handshake. Joins the attempt in progress or, while a retry is scheduled, the
     * next scheduled attempt. Starts an attempt only when none is in progress or scheduled.
     */
    suspend fun connect() {
        if (isConnected) return
        if (isDisposed) throw disposedError()
        val current = synchronized(lock) {
            if (isDisposed) throw disposedError()
            // An attach that finished after the check above leaves no attempt; starting
            // one would attach again and re-send every subscription.
            if (isConnected) return
            attempt
                ?: if (reconnectJob != null) {
                    nextAttempt ?: CompletableDeferred<Unit>().also { nextAttempt = it }
                } else {
                    startAttemptLocked()
                }
        }
        current.await()
    }

    private fun disposedError() = FirebaseFirestoreException(
        "PyricBridgeClient is disposed.",
        FirebaseFirestoreException.Code.UNAVAILABLE
    )

    private fun startAttemptLocked(): CompletableDeferred<Unit> {
        reconnectJob?.cancel()
        reconnectJob = null
        generation += 1
        val attemptGeneration = generation
        val next = CompletableDeferred<Unit>()
        val nextHandshake = CompletableDeferred<Boolean>()
        attempt = next
        handshake = nextHandshake
        if (!hasEverAttached) setState(BridgeConnectionState.CONNECTING)
        val waiting = nextAttempt
        nextAttempt = null
        if (waiting != null) {
            clientScope.launch {
                try {
                    next.await()
                    waiting.complete(Unit)
                } catch (e: Throwable) {
                    waiting.completeExceptionally(e)
                }
            }
        }
        attachDeadlineJob?.cancel()
        attachDeadlineJob = clientScope.launch {
            delay(attachTimeoutMs)
            val expired = synchronized(lock) { attempt === next }
            if (expired) {
                handleConnectionLoss(
                    attemptGeneration,
                    FirebaseFirestoreException(
                        "Timed out connecting to the Pyric bridge.",
                        FirebaseFirestoreException.Code.UNAVAILABLE
                    ),
                    null
                )
            }
        }
        clientScope.launch { runAttempt(attemptGeneration, next, nextHandshake) }
        return next
    }

    private fun isCurrent(attemptGeneration: Int): Boolean =
        synchronized(lock) { attemptGeneration == generation && !isDisposed }

    private suspend fun runAttempt(
        attemptGeneration: Int,
        current: CompletableDeferred<Unit>,
        currentHandshake: CompletableDeferred<Boolean>
    ) {
        try {
            if (directTransport != null) {
                directTransport.setListener(newAttemptListener(attemptGeneration))
                transport = directTransport
                sendAttach()
            } else {
                val factory = transportFactory ?: OkHttpBridgeTransportFactory()
                val listener = newAttemptListener(attemptGeneration)
                val created = factory.create(url, headers, listener)
                if (!isCurrent(attemptGeneration)) {
                    try { created.close(1000, "Superseded") } catch (_: Throwable) {}
                    throw FirebaseFirestoreException(BRIDGE_CONNECTION_LOST_MESSAGE, FirebaseFirestoreException.Code.UNAVAILABLE)
                }
                transport = created
                // onOpen may already have fired on the transport's thread.
                listener.markTransportReady()
            }
            val restoresAuth = currentHandshake.await()
            val restorer = restoreAuth
            var authRestored = true
            if (restoresAuth) {
                try {
                    restorer { method, params ->
                        operationDispatcher.executeOp(
                            method = method,
                            params = params,
                            sendJson = ::sendRawJson,
                            jsonSerializer = JsonCodec::encodeToString
                        )
                    }
                } catch (_: Throwable) {
                    // The Auth observers report the host's state when the restore fails.
                    authRestored = false
                }
            }
            if (!finishAttach(attemptGeneration, authRestored)) {
                throw FirebaseFirestoreException(BRIDGE_CONNECTION_LOST_MESSAGE, FirebaseFirestoreException.Code.UNAVAILABLE)
            }
            current.complete(Unit)
        } catch (e: Throwable) {
            val failure = e as? FirebaseFirestoreException ?: FirebaseFirestoreException(
                "Failed to connect to Pyric bridge: ${e.message}",
                FirebaseFirestoreException.Code.UNAVAILABLE,
                e
            )
            handleConnectionLoss(attemptGeneration, failure, null)
            current.completeExceptionally(failure)
        }
    }

    private fun sendAttach() {
        val frame = BridgeProtocol.createAttachFrame(clientSessionId)
        sendRawJson(JsonCodec.encodeToString(frame))
    }

    private fun finishAttach(attemptGeneration: Int, authRestored: Boolean): Boolean {
        val epoch: Long
        val holdEpoch: Long
        synchronized(lock) {
            if (attemptGeneration != generation || isDisposed) return false
            // Taken before isConnected is set: subscriptions opened mid-restore wait
            // in the restore set so restored listeners always go first (D5).
            epoch = subscriptionManager.beginAttach()
            holdEpoch = heldOperations.epoch()
            attempt = null
            handshake = null
            hasEverAttached = true
            // The restore ran to its result on this connection, so it is not retried.
            needsAuthRestore = false
            attachDeadlineJob?.cancel()
            attachDeadlineJob = null
            reconnectAttempt = 0
            isConnected = true
            startHeartbeatLocked(attemptGeneration)
        }
        subscriptionManager.restoreAll(epoch, ::sendRawJson, JsonCodec::encodeToString)
        // Held operations follow the whole restore. Without the Auth restore they
        // would run as a user the app never was, so they fail instead.
        val identityLost = if (authRestored) null else FirebaseFirestoreException(
            BRIDGE_AUTH_NOT_RESTORED_MESSAGE,
            FirebaseFirestoreException.Code.UNAVAILABLE
        )
        // Publish ATTACHED only once the hold gate opens (D9), so an operation
        // issued upon observing ATTACHED sends directly on the caller's thread.
        heldOperations.release(holdEpoch, identityLost) {
            synchronized(lock) {
                if (attemptGeneration == generation && !isDisposed) {
                    setState(BridgeConnectionState.ATTACHED)
                }
            }
        }
        return true
    }

    /** The ping at attach is what starts the host's watch of this socket. */
    private fun startHeartbeatLocked(attachGeneration: Int) {
        heartbeat.start(
            intervalMs = heartbeatIntervalMs,
            timeoutMs = livenessTimeoutMs,
            ping = { sendPing(attachGeneration) },
            onSilent = {
                handleConnectionLoss(
                    attachGeneration,
                    FirebaseFirestoreException(BRIDGE_HOST_SILENT_MESSAGE, FirebaseFirestoreException.Code.UNAVAILABLE),
                    null
                )
            }
        )
    }

    /**
     * Sends one `ping` on the socket of [attachGeneration], never on an earlier one.
     */
    private fun sendPing(attachGeneration: Int): Boolean {
        val socket = synchronized(lock) {
            val isCurrentSocket = attachGeneration == generation && isConnected && !isDisposed
            if (isCurrentSocket) transport else null
        } ?: return false
        val frame = BridgeProtocol.createPingFrame("ping-${pingCounter.incrementAndGet()}")
        return socket.send(JsonCodec.encodeToString(frame))
    }

    private fun setState(next: BridgeConnectionState, closeError: FirebaseFirestoreException? = null) {
        eventHub.publishConnectionState(next, closeError)
    }

    private fun handleConnectionLoss(
        attemptGeneration: Int,
        error: FirebaseFirestoreException,
        closeCode: Int?
    ) {
        val closing: BridgeTransport?
        val wasAttached: Boolean
        val permitsRetry: Boolean
        val pendingHandshake: CompletableDeferred<Boolean>?
        val pendingAttempt: CompletableDeferred<Unit>?
        synchronized(lock) {
            if (attemptGeneration != generation || isDisposed) return
            permitsRetry = canReopen &&
                (hasEverAttached || retryInitialConnection) &&
                closeCode != BRIDGE_POLICY_CLOSE_CODE
            generation += 1
            heartbeat.stop()
            attachDeadlineJob?.cancel()
            attachDeadlineJob = null
            wasAttached = isConnected
            isConnected = false
            subscriptionManager.endRestore()
            heldOperations.interrupt()
            pendingHandshake = handshake
            pendingAttempt = attempt
            handshake = null
            attempt = null
            closing = transport
            if (canReopen) transport = null
            setState(
                if (permitsRetry) BridgeConnectionState.INTERRUPTED else BridgeConnectionState.CLOSED,
                if (permitsRetry) null else error
            )
            if (permitsRetry) scheduleReconnectLocked()
        }
        pendingHandshake?.completeExceptionally(error)
        pendingAttempt?.completeExceptionally(error)
        if (canReopen && closing != null) {
            try { closing.close(1000, "Connection lost") } catch (_: Throwable) {}
        }

        if (!permitsRetry) {
            val waiting = synchronized(lock) { nextAttempt.also { nextAttempt = null } }
            waiting?.completeExceptionally(error)
            heldOperations.fail(error)
            operationDispatcher.failAll(error.code, error.message ?: BRIDGE_CONNECTION_LOST_MESSAGE, error.cause)
            subscriptionManager.failAll(error.code, error.message ?: BRIDGE_CONNECTION_LOST_MESSAGE, error.cause)
            return
        }

        operationDispatcher.failAll(FirebaseFirestoreException.Code.UNAVAILABLE, BRIDGE_CONNECTION_LOST_MESSAGE, keepUnsent = true)
        if (wasAttached) subscriptionManager.reportGap()
    }

    private fun scheduleReconnectLocked() {
        val delayMs = reconnectDelayMs(reconnectAttempt)
        reconnectAttempt += 1
        reconnectJob?.cancel()
        reconnectJob = clientScope.launch {
            if (delayMs > 0) delay(delayMs)
            val next = synchronized(lock) {
                reconnectJob = null
                if (isDisposed || attempt != null || isConnected) null else startAttemptLocked()
            }
            try { next?.await() } catch (_: Throwable) {}
        }
    }

    suspend fun op(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null
    ): Any? = opSequenced(method, params, actAs, timeoutMs).value

    internal suspend fun opSequenced(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null
    ): BridgeSequencedResult {
        if (isDisposed) throw disposedError()
        val resolvedParams = BridgeAppCheckAttachment.attachToOpParams(method, params, appCheckTokenProvider)
        val start = {
            operationDispatcher.dispatch(
                method = method,
                params = resolvedParams,
                actAs = actAs,
                timeoutMs = timeoutMs,
                // A client that cannot reopen its transport has no reconnect to hold for.
                holdsRefusal = canReopen,
                sendJson = ::sendRawJson,
                jsonSerializer = JsonCodec::encodeToString
            )
        }
        val admission = heldOperations.admit(holdTimeoutMs, start)
        if (admission.direct) {
            heldOperations.sendDirect(admission.entry)
        } else {
            startAttemptIfIdle()
        }
        return heldOperations.await(admission.entry)
    }

    /** A held operation never starts an attempt ahead of the reconnect schedule. */
    private fun startAttemptIfIdle() {
        synchronized(lock) {
            val idle = !isDisposed && !isConnected && attempt == null && reconnectJob == null
            if (idle) startAttemptLocked()
        }
    }

    private val subscriptionWiring = BridgeSubscriptionWiring(
        isAttached = { isConnected },
        ensureConnected = ::ensureConnectedForSubscription,
        keepsOnConnectFailure = { !isDisposed && canReopen && (hasEverAttached || retryInitialConnection) },
        sendJson = ::sendRawJson,
        jsonSerializer = JsonCodec::encodeToString
    )

    private fun checkNotDisposedForSubscribe() {
        if (isDisposed) throw FirebaseFirestoreException("PyricBridgeClient has been disposed.", FirebaseFirestoreException.Code.UNAVAILABLE)
    }

    /** Opens a subscription that survives drops until the flow is cancelled. */
    fun subscribe(target: Any, actAs: Map<String, Any?>? = null, includeMetadataChanges: Boolean = false, listenSource: String? = null): Flow<Any?> {
        checkNotDisposedForSubscribe()
        return subscriptionManager.subscribe(
            target, actAs, includeMetadataChanges, listenSource, appCheckTokenProvider, clientScope,
            subscriptionWiring.isAttached, subscriptionWiring.ensureConnected, subscriptionWiring.keepsOnConnectFailure,
            subscriptionWiring.sendJson, subscriptionWiring.jsonSerializer
        )
    }

    internal fun openSubscription(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        onValue: (Any?) -> Unit,
        onWireError: (FirebaseFirestoreException) -> Unit,
        onCloseError: (FirebaseFirestoreException) -> Unit
    ): BridgeSubscriptionHandle {
        checkNotDisposedForSubscribe()
        return subscriptionWiring.open(
            subscriptionManager, clientScope, appCheckTokenProvider, target, actAs,
            includeMetadataChanges, listenSource, onValue, onWireError, onCloseError
        )
    }

    internal fun openSequencedSubscription(target: Any): SequencedSubscriptionHandle {
        if (isDisposed) throw disposedError()
        return subscriptionManager.openSequencedSubscription(
            target, clientScope, subscriptionWiring.isAttached, subscriptionWiring.ensureConnected,
            subscriptionWiring.keepsOnConnectFailure, subscriptionWiring.sendJson, subscriptionWiring.jsonSerializer
        )
    }

    internal fun subscribeSequenced(target: Any): Flow<BridgeSequencedSnapshot> {
        if (isDisposed) throw disposedError()
        return subscriptionManager.subscribeSequenced(
            target, subscriptionWiring.isAttached, subscriptionWiring.ensureConnected,
            subscriptionWiring.keepsOnConnectFailure, subscriptionWiring.sendJson, subscriptionWiring.jsonSerializer
        )
    }

    private suspend fun ensureConnectedForSubscription() {
        if (synchronized(lock) { hasEverAttached && canReopen }) return
        connect()
    }

    suspend fun disconnect() = disconnectInternal()

    fun terminate(): Task<Void?> {
        disconnectInternal()
        clientScope.cancel()
        deliveryQueue.shutdown()
        return Tasks.forResult(null)
    }

    private fun disconnectInternal() {
        val disconnectError = FirebaseFirestoreException(BRIDGE_DISCONNECTED_MESSAGE, FirebaseFirestoreException.Code.UNAVAILABLE)
        val closing: BridgeTransport?
        val pendingHandshake: CompletableDeferred<Boolean>?
        val pendingAttempt: CompletableDeferred<Unit>?
        synchronized(lock) {
            isDisposed = true
            isConnected = false
            generation += 1
            heartbeat.stop()
            reconnectJob?.cancel(); reconnectJob = null
            attachDeadlineJob?.cancel(); attachDeadlineJob = null
            nextAttempt?.completeExceptionally(disposedError()); nextAttempt = null
            pendingHandshake = handshake; handshake = null
            pendingAttempt = attempt; attempt = null
            closing = transport; transport = null
            setState(BridgeConnectionState.CLOSED, disconnectError)
        }
        restoreAuth = {}
        appCheckTokenProvider = null
        heldOperations.dispose(disconnectError)
        operationDispatcher.failAll(FirebaseFirestoreException.Code.UNAVAILABLE, BRIDGE_DISCONNECTED_MESSAGE)
        subscriptionManager.failAll(FirebaseFirestoreException.Code.UNAVAILABLE, BRIDGE_DISCONNECTED_MESSAGE)
        val closedBeforeHandshake = FirebaseFirestoreException(
            "Connection closed before handshake completion.",
            FirebaseFirestoreException.Code.UNAVAILABLE
        )
        pendingHandshake?.completeExceptionally(closedBeforeHandshake)
        pendingAttempt?.completeExceptionally(closedBeforeHandshake)
        try { closing?.close(1000, "Client closed") } catch (_: Throwable) {}
    }

    /** Throws [TransportRefused] when the frame cannot have left the device. */
    private fun sendRawJson(json: String) {
        val currentTransport = transport
        if (currentTransport == null || isDisposed) {
            throw TransportRefused("Cannot send message: transport is not connected.")
        }
        if (!currentTransport.send(json)) {
            throw TransportRefused("Failed to enqueue message to bridge transport.")
        }
    }

    private fun newAttemptListener(listenerGeneration: Int): BridgeSocketAttemptListener =
        BridgeSocketAttemptListener(
            listenerGeneration = listenerGeneration,
            usesDirectTransport = directTransport != null,
            currentClientGeneration = { synchronized(lock) { generation } },
            isCurrentGeneration = ::isCurrent,
            nextInboundWireSeq = inboundWireSeq::incrementAndGet,
            onFrameHeard = heartbeat::heard,
            sendAttach = ::sendAttach,
            sendRawJson = ::sendRawJson,
            onAttachAck = ::acceptAttachAck,
            onWorkerRes = operationDispatcher::handleWorkerRes,
            onWorkerSnap = { msg, seq -> subscriptionManager.handleWorkerSnap(msg, ::sendRawJson, JsonCodec::encodeToString, seq) },
            onRemoteLens = eventHub::publishRemoteLens,
            onConnectionLoss = ::handleConnectionLoss
        )

    private fun acceptAttachAck(attemptGeneration: Int, msg: Map<String, Any?>) {
        val pendingHandshake: CompletableDeferred<Boolean>
        val restoresAuth: Boolean
        synchronized(lock) {
            if (attemptGeneration != generation || isDisposed) return
            pendingHandshake = handshake ?: return
            val ackSessionId = (msg["clientSessionId"] as? String) ?: (msg["sessionId"] as? String)
            if (ackSessionId != null) clientSessionId = ackSessionId
            val ackHostId = msg["hostInstanceId"] as? String
            val changedHost = hasEverAttached && hostInstanceId != null && ackHostId != null && ackHostId != hostInstanceId
            if (ackHostId != null) hostInstanceId = ackHostId
            if (changedHost) needsAuthRestore = true
            restoresAuth = needsAuthRestore
        }
        pendingHandshake.complete(restoresAuth)
    }

    companion object {
        fun defaultHeaders(url: String): Map<String, String> = computeBridgeHostHeaders(url)

        fun createDefault(): PyricBridgeClient =
            PyricBridgeClient(url = BridgeProtocol.resolveDefaultBridgeUrl())
    }
}
