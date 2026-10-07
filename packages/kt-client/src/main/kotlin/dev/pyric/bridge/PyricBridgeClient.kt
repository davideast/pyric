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
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/**
 * The bridge client's transport state. `INTERRUPTED` covers every reconnect
 * attempt after a drop. `CLOSED` means no reconnect is scheduled.
 */
enum class BridgeConnectionState { CONNECTING, ATTACHED, INTERRUPTED, CLOSED }

/** Sends one worker operation on the connection being restored. */
typealias BridgeRestoreOperation = suspend (method: String, params: Map<String, Any?>) -> Any?

/** Re-establishes the session's Auth user on a replaced bridge host. */
typealias BridgeAuthRestorer = suspend (op: BridgeRestoreOperation) -> Unit

/**
 * The wait in milliseconds before reconnect attempt [attempt] (0-based): 250 ms
 * doubling to a 5 s cap, plus up to 250 ms of jitter, never above 5 s.
 */
fun bridgeReconnectDelayMs(attempt: Int, random: Double = Math.random()): Long {
    val exponent = attempt.coerceIn(0, 10)
    val base = min(5000.0, 250.0 * (1 shl exponent))
    val jitter = random * min(250.0, base / 10.0)
    return min(5000.0, base + jitter).toLong()
}

private const val CONNECTION_LOST =
    "The bridge connection was lost. Requests already sent may have completed; check state before retrying."
private const val POLICY_CLOSE_CODE = 1008

/**
 * WebSocket transport to the Pyric bridge.
 *
 * After the first attach, a dropped socket is reopened with bounded backoff. The
 * client re-attaches with its `clientSessionId` and re-sends every live
 * subscription. Operations in flight at the drop fail once with `UNAVAILABLE` and
 * are never re-sent. A client built on one supplied transport cannot reopen it,
 * so a drop fails its operations and subscriptions instead.
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
    private var reconnectAttempt = 0
    private var reconnectJob: Job? = null
    private var attachDeadlineJob: Job? = null
    /** Callers waiting for the next scheduled attempt. */
    private var nextAttempt: CompletableDeferred<Unit>? = null

    /** Runs on a re-attach to a replaced host, before subscriptions are re-sent. */
    @Volatile
    var restoreAuth: BridgeAuthRestorer = {}

    /** The client session ID acknowledged by the bridge. */
    @Volatile
    var clientSessionId: String? = null
        private set

    private val _connectionStateFlow = MutableStateFlow(false)
    val connectionStateFlow: StateFlow<Boolean> = _connectionStateFlow.asStateFlow()

    private val _connectionStates = MutableStateFlow(BridgeConnectionState.CONNECTING)
    val connectionStates: StateFlow<BridgeConnectionState> = _connectionStates.asStateFlow()

    val connectionState: BridgeConnectionState get() = _connectionStates.value

    @Volatile
    var isConnected: Boolean = false
        private set(value) {
            field = value
            _connectionStateFlow.value = value
        }

    @Volatile
    var isDisposed: Boolean = false
        private set

    private val _remoteLensEvents = MutableSharedFlow<AuthLens>(replay = 1, extraBufferCapacity = 16)
    val remoteLensEvents: SharedFlow<AuthLens> = _remoteLensEvents.asSharedFlow()

    private val _denialEvents = MutableSharedFlow<FirebaseFirestoreException>(extraBufferCapacity = 64)
    val denialEvents: SharedFlow<FirebaseFirestoreException> = _denialEvents.asSharedFlow()

    internal fun dispatchDenial(exception: FirebaseFirestoreException) {
        if (exception.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            _denialEvents.tryEmit(exception)
        }
    }

    private val operationDispatcher = BridgeOperationDispatcher(clientScope, defaultOpTimeoutMs, onDenial = ::dispatchDenial)
    private val subscriptionManager = BridgeSubscriptionManager(onDenial = ::dispatchDenial)

    private val canReopen: Boolean get() = directTransport == null

    constructor(transport: BridgeTransport) : this(
        url = BridgeProtocol.DEFAULT_BRIDGE_URL,
        headers = emptyMap(),
        defaultOpTimeoutMs = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
        transportFactory = null,
        directTransport = transport
    )

    init {
        directTransport?.setListener(BridgeClientListener(0))
        clientScope.launch {
            try {
                connect()
            } catch (_: Throwable) {}
        }
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
            // An attach may have finished since the check above; starting another
            // attempt would attach twice and re-send every subscription.
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
                directTransport.setListener(BridgeClientListener(attemptGeneration))
                transport = directTransport
                sendAttach()
            } else {
                val factory = transportFactory ?: OkHttpBridgeTransportFactory()
                val listener = BridgeClientListener(attemptGeneration)
                val created = factory.create(url, headers, listener)
                if (!isCurrent(attemptGeneration)) {
                    try { created.close(1000, "Superseded") } catch (_: Throwable) {}
                    throw FirebaseFirestoreException(CONNECTION_LOST, FirebaseFirestoreException.Code.UNAVAILABLE)
                }
                transport = created
                // onOpen may already have fired on the transport's thread.
                listener.markTransportReady()
            }
            val changedHost = currentHandshake.await()
            val restorer = restoreAuth
            if (changedHost) {
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
                }
            }
            if (!finishAttach(attemptGeneration)) {
                throw FirebaseFirestoreException(CONNECTION_LOST, FirebaseFirestoreException.Code.UNAVAILABLE)
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

    private fun finishAttach(attemptGeneration: Int): Boolean {
        synchronized(lock) {
            if (attemptGeneration != generation || isDisposed) return false
            attempt = null
            handshake = null
            hasEverAttached = true
            attachDeadlineJob?.cancel()
            attachDeadlineJob = null
            reconnectAttempt = 0
            isConnected = true
            setState(BridgeConnectionState.ATTACHED)
        }
        subscriptionManager.restoreAll(::sendRawJson, JsonCodec::encodeToString)
        return true
    }

    private fun setState(next: BridgeConnectionState) {
        _connectionStates.value = next
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
                closeCode != POLICY_CLOSE_CODE
            generation += 1
            attachDeadlineJob?.cancel()
            attachDeadlineJob = null
            wasAttached = connectionState == BridgeConnectionState.ATTACHED
            isConnected = false
            pendingHandshake = handshake
            pendingAttempt = attempt
            handshake = null
            attempt = null
            closing = transport
            if (canReopen) transport = null
            setState(if (permitsRetry) BridgeConnectionState.INTERRUPTED else BridgeConnectionState.CLOSED)
        }
        pendingHandshake?.completeExceptionally(error)
        pendingAttempt?.completeExceptionally(error)
        if (canReopen && closing != null) {
            try { closing.close(1000, "Connection lost") } catch (_: Throwable) {}
        }

        if (!permitsRetry) {
            val waiting = synchronized(lock) { nextAttempt.also { nextAttempt = null } }
            waiting?.completeExceptionally(error)
            operationDispatcher.failAll(error.code, error.message ?: CONNECTION_LOST, error.cause)
            subscriptionManager.failAll(error.code, error.message ?: CONNECTION_LOST, error.cause)
            return
        }

        operationDispatcher.failAll(FirebaseFirestoreException.Code.UNAVAILABLE, CONNECTION_LOST)
        if (wasAttached) subscriptionManager.reportGap()

        synchronized(lock) {
            if (isDisposed) return
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
    }

    suspend fun op(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null
    ): Any? {
        if (isDisposed) throw disposedError()
        if (!isConnected) {
            val interrupted = synchronized(lock) { hasEverAttached && canReopen }
            if (interrupted) {
                throw FirebaseFirestoreException(CONNECTION_LOST, FirebaseFirestoreException.Code.UNAVAILABLE)
            }
            connect()
        }
        if (isDisposed) throw disposedError()

        return operationDispatcher.executeOp(
            method = method,
            params = params,
            actAs = actAs,
            timeoutMs = timeoutMs,
            sendJson = ::sendRawJson,
            jsonSerializer = JsonCodec::encodeToString
        )
    }

    /**
     * Opens a subscription. It survives a dropped connection: the client re-sends
     * it on every re-attach until the flow is cancelled.
     */
    fun subscribe(
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null
    ): Flow<Any?> {
        if (isDisposed) {
            throw FirebaseFirestoreException(
                "PyricBridgeClient has been disposed.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        }

        return subscriptionManager.subscribe(
            target = target,
            actAs = actAs,
            includeMetadataChanges = includeMetadataChanges,
            listenSource = listenSource,
            isAttached = { isConnected },
            ensureConnected = ::ensureConnectedForSubscription,
            keepsSubscriptionOnConnectFailure = { !isDisposed && canReopen && (hasEverAttached || retryInitialConnection) },
            sendJson = ::sendRawJson,
            jsonSerializer = JsonCodec::encodeToString
        )
    }

    private suspend fun ensureConnectedForSubscription() {
        val interrupted = synchronized(lock) { hasEverAttached && canReopen }
        // An interrupted client re-sends this subscription on its next attach.
        if (interrupted) return
        connect()
    }

    suspend fun disconnect() {
        disconnectInternal()
    }

    fun terminate(): Task<Void?> {
        disconnectInternal()
        clientScope.cancel()
        return Tasks.forResult(null)
    }

    private fun disconnectInternal() {
        val closing: BridgeTransport?
        val pendingHandshake: CompletableDeferred<Boolean>?
        val pendingAttempt: CompletableDeferred<Unit>?
        synchronized(lock) {
            isDisposed = true
            isConnected = false
            generation += 1
            reconnectJob?.cancel()
            reconnectJob = null
            attachDeadlineJob?.cancel()
            attachDeadlineJob = null
            nextAttempt?.completeExceptionally(disposedError())
            nextAttempt = null
            pendingHandshake = handshake
            pendingAttempt = attempt
            handshake = null
            attempt = null
            closing = transport
            transport = null
            setState(BridgeConnectionState.CLOSED)
        }
        restoreAuth = {}

        operationDispatcher.failAll(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            "PyricBridgeClient disconnected."
        )
        subscriptionManager.failAll(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            "PyricBridgeClient disconnected."
        )

        val closedBeforeHandshake = FirebaseFirestoreException(
            "Connection closed before handshake completion.",
            FirebaseFirestoreException.Code.UNAVAILABLE
        )
        pendingHandshake?.completeExceptionally(closedBeforeHandshake)
        pendingAttempt?.completeExceptionally(closedBeforeHandshake)

        try {
            closing?.close(1000, "Client closed")
        } catch (_: Throwable) {}
    }

    private fun sendRawJson(json: String) {
        val currentTransport = transport
        if (currentTransport == null || isDisposed) {
            throw FirebaseFirestoreException(
                "Cannot send message: transport is not connected.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        }
        val enqueued = currentTransport.send(json)
        if (!enqueued) {
            throw FirebaseFirestoreException(
                "Failed to enqueue message to bridge transport.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        }
    }

    private inner class BridgeClientListener(private val listenerGeneration: Int) : BridgeListener {
        // Every attempt installs its own listener, so a late close or failure from
        // an earlier attempt is stale, including on a supplied transport.
        private fun currentGeneration(): Int = listenerGeneration

        private fun isStale(): Boolean = !isCurrent(currentGeneration())

        // A supplied transport may still deliver frames through a listener it read
        // before the latest attempt replaced it; its frames belong to the current attempt.
        private fun messageGeneration(): Int =
            if (directTransport != null) synchronized(lock) { generation } else listenerGeneration

        @Volatile private var opened = false
        @Volatile private var transportReady = false
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
                handleConnectionLoss(
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
            if (!isCurrent(messageGeneration())) return
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
                BridgeProtocol.TYPE_WORKER_RES -> {
                    operationDispatcher.handleWorkerRes(msg)
                }
                BridgeProtocol.TYPE_WORKER_SNAP -> {
                    subscriptionManager.handleWorkerSnap(
                        msg,
                        ::sendRawJson,
                        JsonCodec::encodeToString
                    )
                }
                BridgeProtocol.TYPE_WORKER_EVENT -> {
                    handleWorkerEvent(msg)
                }
            }
        }

        private fun handleAttachAck(msg: Map<String, Any?>) {
            val attemptGeneration = messageGeneration()
            val peerConnected = msg["peerConnected"] == true
            if (!peerConnected) {
                handleConnectionLoss(
                    attemptGeneration,
                    FirebaseFirestoreException(
                        "No browser tab is connected to the sandbox; open pyric sandbox in a browser and retry.",
                        FirebaseFirestoreException.Code.UNAVAILABLE
                    ),
                    null
                )
                return
            }
            val pendingHandshake: CompletableDeferred<Boolean>
            val changedHost: Boolean
            synchronized(lock) {
                if (attemptGeneration != generation || isDisposed) return
                pendingHandshake = handshake ?: return
                val ackSessionId = (msg["clientSessionId"] as? String) ?: (msg["sessionId"] as? String)
                if (ackSessionId != null) clientSessionId = ackSessionId
                val ackHostId = msg["hostInstanceId"] as? String
                changedHost = hasEverAttached && hostInstanceId != null && ackHostId != null && ackHostId != hostInstanceId
                if (ackHostId != null) hostInstanceId = ackHostId
            }
            pendingHandshake.complete(changedHost)
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
                    _remoteLensEvents.tryEmit(lens)
                }
            }
        }

        // The peer's close frame ends the connection; onClosed then arrives for a stale generation.
        override fun onClosing(code: Int, reason: String) = onClosed(code, reason)

        override fun onClosed(code: Int, reason: String) {
            handleConnectionLoss(
                currentGeneration(),
                FirebaseFirestoreException(
                    "Bridge connection closed: $reason ($code)",
                    FirebaseFirestoreException.Code.UNAVAILABLE
                ),
                code
            )
        }

        override fun onFailure(throwable: Throwable) {
            handleConnectionLoss(
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

    companion object {
        fun defaultHeaders(url: String): Map<String, String> {
            val host = try {
                val uri = java.net.URI(url)
                val portStr = if (uri.port != -1) ":${uri.port}" else ""
                "${uri.host}$portStr"
            } catch (_: Throwable) {
                "127.0.0.1:5174"
            }
            return mapOf("Host" to host)
        }

        fun createDefault(): PyricBridgeClient = PyricBridgeClient()
    }
}
