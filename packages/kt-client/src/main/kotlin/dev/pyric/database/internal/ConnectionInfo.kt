package dev.pyric.database.internal

import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.PyricBridgeClient
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The `.info` tree the client serves itself (ADR-0019, amendment "every client
 * serves `.info` locally"). Listeners and reads on these paths never reach the
 * host and are not replayed on re-attach.
 */
internal const val INFO_ROOT = ".info"

/** The bridge handshake carries no server timestamp, so the offset is always 0. */
internal const val SERVER_TIME_OFFSET = 0L

/** A path is under `/.info` when its first segment is `.info`, as `isInfoPath` in writable-path.ts tests it. */
internal fun isInfoPath(path: String): Boolean =
    path.trim('/').substringBefore('/') == INFO_ROOT

/** Connected while the bridge is attached and the database's network flag is on. */
internal fun isConnected(state: BridgeConnectionState, online: Boolean): Boolean =
    state == BridgeConnectionState.ATTACHED && online

/** The value served at [path], a path under `/.info`. */
internal fun infoValue(path: String, connected: Boolean): Any? {
    val rest = path.trim('/').removePrefix(INFO_ROOT).trim('/')
    return when (rest) {
        "" -> mapOf("connected" to connected, "serverTimeOffset" to SERVER_TIME_OFFSET)
        "connected" -> connected
        "serverTimeOffset" -> SERVER_TIME_OFFSET
        else -> null
    }
}

internal interface InfoListenerHandle {
    fun cancel()
}

/**
 * Non-conflating `.info` event hub for one `FirebaseDatabase` instance.
 *
 * Driven directly from [PyricBridgeClient] state transitions and `goOffline()` /
 * `goOnline()` through [PyricBridgeClient.deliveryQueue] so:
 * - rapid `ATTACHED -> INTERRUPTED -> ATTACHED` transitions while a callback is
 *   busy are never conflated away (K15, D8);
 * - `.info` listeners end once with the close error on `CLOSED` and receive no
 *   spurious `false` after `disconnect()` returns (K12, D6);
 * - `.info` `get()` reads through the same ordered queue so it never runs ahead
 *   of a queued `goOffline()` / drop transition (K15, D9).
 *
 * Lock order: `PyricBridgeClient.lock` -> `BridgeEventHub.connectionLock` -> `lock` -> `deliveryQueue.enqueue`.
 */
internal class InfoConnectionHub(
    private val bridgeClient: PyricBridgeClient
) {
    private class Entry(
        val path: String,
        val onValue: (Any?) -> Unit,
        val onCloseError: (FirebaseFirestoreException) -> Unit,
        val onImmediateClose: ((FirebaseFirestoreException) -> Unit)?
    ) {
        @Volatile var active: Boolean = true
        private val ended = AtomicBoolean(false)
        // Accessed exclusively on bridgeClient.deliveryQueue.
        private var hasDelivered = false
        private var lastDelivered: Any? = null

        fun deliverInitialIfActive(connected: Boolean) {
            if (!active) return
            val next = infoValue(path, connected)
            hasDelivered = true
            lastDelivered = next
            onValue(next)
        }

        fun deliverIfActive(connected: Boolean) {
            if (!active) return
            val next = infoValue(path, connected)
            if (hasDelivered && lastDelivered == next) return
            hasDelivered = true
            lastDelivered = next
            onValue(next)
        }

        fun deliverCloseErrorOnce(error: FirebaseFirestoreException) {
            if (ended.compareAndSet(false, true)) {
                onCloseError(error)
            }
        }
    }

    private val lock = Any()
    private var initialized = false
    private var bridgeState: BridgeConnectionState = BridgeConnectionState.CONNECTING
    private var networkEnabled: Boolean = true
    private var closedError: FirebaseFirestoreException? = null
    private val listeners = LinkedHashSet<Entry>()

    @Volatile
    private var deliveredConnected: Boolean = false

    private val unregisterObserver: () -> Unit = bridgeClient.addConnectionStateObserver { next, closeError ->
        onBridgeStateChange(next, closeError)
    }

    private fun onBridgeStateChange(
        next: BridgeConnectionState,
        closeError: FirebaseFirestoreException?
    ) {
        val immediateClosed: List<Entry>
        synchronized(lock) {
            bridgeState = next
            if (!initialized) {
                initialized = true
                closedError = if (next == BridgeConnectionState.CLOSED) closeError else null
                deliveredConnected = isConnected(next, networkEnabled)
                return
            }
            if (next == BridgeConnectionState.CLOSED && closeError != null) {
                closedError = closeError
                immediateClosed = listeners.toList()
                listeners.clear()
                for (entry in immediateClosed) {
                    entry.active = false
                }
                bridgeClient.deliveryQueue.enqueue {
                    deliveredConnected = false
                    for (entry in immediateClosed) {
                        entry.deliverCloseErrorOnce(closeError)
                    }
                }
            } else {
                immediateClosed = emptyList()
                closedError = null
                val connected = isConnected(next, networkEnabled)
                val snapshot = listeners.toList()
                bridgeClient.deliveryQueue.enqueue {
                    deliveredConnected = connected
                    for (entry in snapshot) {
                        entry.deliverIfActive(connected)
                    }
                }
            }
        }
        if (closeError != null) {
            for (entry in immediateClosed) {
                entry.onImmediateClose?.invoke(closeError)
            }
        }
    }

    fun setNetworkEnabled(online: Boolean) {
        synchronized(lock) {
            if (networkEnabled == online) return
            networkEnabled = online
            if (closedError != null) return
            val connected = isConnected(bridgeState, networkEnabled)
            val snapshot = listeners.toList()
            bridgeClient.deliveryQueue.enqueue {
                deliveredConnected = connected
                for (entry in snapshot) {
                    entry.deliverIfActive(connected)
                }
            }
        }
    }

    fun registerListener(
        path: String,
        onValue: (Any?) -> Unit,
        onCloseError: (FirebaseFirestoreException) -> Unit,
        onImmediateClose: ((FirebaseFirestoreException) -> Unit)? = null
    ): InfoListenerHandle {
        val entry = Entry(path, onValue, onCloseError, onImmediateClose)
        val alreadyClosed: FirebaseFirestoreException?
        synchronized(lock) {
            alreadyClosed = closedError
            if (alreadyClosed != null) {
                entry.active = false
                bridgeClient.deliveryQueue.enqueue {
                    entry.deliverCloseErrorOnce(alreadyClosed)
                }
            } else {
                listeners.add(entry)
                val initialConnected = isConnected(bridgeState, networkEnabled)
                bridgeClient.deliveryQueue.enqueue {
                    entry.deliverInitialIfActive(initialConnected)
                }
            }
        }
        if (alreadyClosed != null) {
            onImmediateClose?.invoke(alreadyClosed)
        }
        return object : InfoListenerHandle {
            override fun cancel() {
                synchronized(lock) {
                    entry.active = false
                    listeners.remove(entry)
                }
            }
        }
    }

    fun readValue(path: String, tcs: TaskCompletionSource<Any?>) {
        if (bridgeClient.deliveryQueue.isOnDeliveryThread()) {
            tcs.setResult(infoValue(path, deliveredConnected))
            return
        }
        val queued = bridgeClient.deliveryQueue.enqueue {
            tcs.setResult(infoValue(path, deliveredConnected))
        }
        if (!queued) {
            val live = synchronized(lock) { isConnected(bridgeState, networkEnabled) }
            tcs.setResult(infoValue(path, live))
        }
    }

    fun dispose() {
        unregisterObserver()
        synchronized(lock) {
            for (entry in listeners) {
                entry.active = false
            }
            listeners.clear()
        }
    }
}
