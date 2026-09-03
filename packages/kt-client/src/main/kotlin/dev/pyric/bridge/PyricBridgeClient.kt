package dev.pyric.bridge

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class PyricBridgeClient(
    val url: String = BridgeProtocol.DEFAULT_BRIDGE_URL,
    val headers: Map<String, String> = defaultHeaders(url),
    val defaultOpTimeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
    private val transportFactory: BridgeTransportFactory? = null,
    private val directTransport: BridgeTransport? = null
) {
    private val clientScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val connectMutex = Mutex()

    private var transport: BridgeTransport? = directTransport
    private var handshakeDeferred: CompletableDeferred<Unit>? = null

    @Volatile
    var isConnected: Boolean = false
        private set

    @Volatile
    var isDisposed: Boolean = false
        private set

    private val operationDispatcher = BridgeOperationDispatcher(clientScope, defaultOpTimeoutMs)
    private val subscriptionManager = BridgeSubscriptionManager()

    constructor(transport: BridgeTransport) : this(
        url = BridgeProtocol.DEFAULT_BRIDGE_URL,
        headers = emptyMap(),
        defaultOpTimeoutMs = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
        transportFactory = null,
        directTransport = transport
    )

    init {
        directTransport?.setListener(BridgeClientListener())
    }

    suspend fun connect() {
        if (isConnected) return
        if (isDisposed) {
            throw FirebaseFirestoreException(
                "PyricBridgeClient is disposed.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        }

        connectMutex.withLock {
            if (isConnected) return
            if (isDisposed) {
                throw FirebaseFirestoreException(
                    "PyricBridgeClient is disposed.",
                    FirebaseFirestoreException.Code.UNAVAILABLE
                )
            }

            val currentDeferred = handshakeDeferred
            if (currentDeferred != null && !currentDeferred.isCompleted) {
                currentDeferred.await()
                return
            }

            val deferred = CompletableDeferred<Unit>()
            handshakeDeferred = deferred

            try {
                if (directTransport != null) {
                    transport = directTransport
                    // Direct transport: initiate handshake
                    sendRawJson(JsonCodec.encodeToString(BridgeProtocol.createAttachFrame()))
                } else {
                    val factory = transportFactory ?: OkHttpBridgeTransportFactory()
                    val createdTransport = factory.create(url, headers, BridgeClientListener())
                    transport = createdTransport
                }
                deferred.await()
                isConnected = true
            } catch (e: Throwable) {
                disconnectInternal()
                if (e is FirebaseFirestoreException) throw e
                throw FirebaseFirestoreException(
                    "Failed to connect to Pyric bridge: ${e.message}",
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    e
                )
            }
        }
    }

    suspend fun op(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null
    ): Any? {
        if (!isConnected && !isDisposed) {
            connect()
        }
        if (isDisposed) {
            throw FirebaseFirestoreException(
                "PyricBridgeClient is disposed.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        }

        return operationDispatcher.executeOp(
            method = method,
            params = params,
            actAs = actAs,
            timeoutMs = timeoutMs,
            sendJson = ::sendRawJson,
            jsonSerializer = JsonCodec::encodeToString
        )
    }

    fun subscribe(
        target: Map<String, Any?>,
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
            ensureConnected = ::connect,
            sendJson = ::sendRawJson,
            jsonSerializer = JsonCodec::encodeToString
        )
    }

    suspend fun disconnect() {
        disconnectInternal()
    }

    fun terminate(): Task<Void?> {
        isDisposed = true
        isConnected = false
        disconnectInternal()
        clientScope.cancel()
        return Tasks.forResult(null)
    }

    private fun disconnectInternal() {
        isDisposed = true
        isConnected = false

        operationDispatcher.failAll(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            "PyricBridgeClient disconnected."
        )
        subscriptionManager.failAll(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            "PyricBridgeClient disconnected."
        )

        handshakeDeferred?.completeExceptionally(
            FirebaseFirestoreException(
                "Connection closed before handshake completion.",
                FirebaseFirestoreException.Code.UNAVAILABLE
            )
        )

        try {
            transport?.close(1000, "Client closed")
        } catch (_: Throwable) {}
        transport = null
    }

    private fun sendRawJson(json: String) {
        val currentTransport = transport
        if (currentTransport == null || (!isConnected && handshakeDeferred?.isCompleted != false && directTransport == null)) {
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

    private inner class BridgeClientListener : BridgeListener {
        override fun onOpen() {
            try {
                sendRawJson(JsonCodec.encodeToString(BridgeProtocol.createAttachFrame()))
            } catch (e: Throwable) {
                handshakeDeferred?.completeExceptionally(e)
            }
        }

        override fun onMessage(text: String) {
            val msg = try {
                JsonCodec.decodeMap(text)
            } catch (_: Exception) {
                return
            }

            when (msg["type"] as? String) {
                BridgeProtocol.TYPE_ATTACH_ACK -> {
                    val peerConnected = msg["peerConnected"] == true
                    if (!peerConnected) {
                        handshakeDeferred?.completeExceptionally(
                            FirebaseFirestoreException(
                                "No browser tab is connected to the sandbox — open pyric sandbox in a browser and retry.",
                                FirebaseFirestoreException.Code.UNAVAILABLE
                            )
                        )
                    } else {
                        handshakeDeferred?.complete(Unit)
                    }
                }
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
            }
        }

        override fun onClosing(code: Int, reason: String) {}

        override fun onClosed(code: Int, reason: String) {
            if (!isDisposed) {
                isConnected = false
                operationDispatcher.failAll(
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    "Bridge connection closed: $reason ($code)"
                )
            }
        }

        override fun onFailure(throwable: Throwable) {
            if (!isDisposed) {
                isConnected = false
                handshakeDeferred?.completeExceptionally(throwable)
                operationDispatcher.failAll(
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    "Bridge connection failed: ${throwable.message}",
                    throwable
                )
            }
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
