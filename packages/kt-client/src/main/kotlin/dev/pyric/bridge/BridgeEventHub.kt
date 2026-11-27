package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

internal fun interface BridgeConnectionObserver {
    fun onStateChange(state: BridgeConnectionState, closeError: FirebaseFirestoreException?)
}

/**
 * Lossless local event hub owned by one [PyricBridgeClient].
 *
 * Keeps public [StateFlow]/[SharedFlow] streams compatible while giving internal
 * SDK layers synchronous registration (D7) and non-conflating, ordered delivery
 * through [BridgeDeliveryQueue] (D6, D8, D9).
 *
 * Lock order: `PyricBridgeClient.lock` -> `connectionLock` -> observer lock -> `deliveryQueue.enqueue`.
 */
internal class BridgeEventHub(
    private val deliveryQueue: BridgeDeliveryQueue
) {
    private val connectionLock = Any()
    private val lensLock = Any()
    private val denialLock = Any()

    private val _connectionStates = MutableStateFlow(BridgeConnectionState.CONNECTING)
    val connectionStates: StateFlow<BridgeConnectionState> = _connectionStates.asStateFlow()
    val connectionState: BridgeConnectionState get() = _connectionStates.value

    private var lastCloseError: FirebaseFirestoreException? = null
    private val connectionObservers = LinkedHashSet<BridgeConnectionObserver>()

    private val _remoteLensEvents = MutableSharedFlow<AuthLens>(replay = 1, extraBufferCapacity = EVENT_BUFFER_CAPACITY)
    val remoteLensEvents: SharedFlow<AuthLens> = _remoteLensEvents.asSharedFlow()
    private var lastRemoteLens: AuthLens? = null
    private val remoteLensObservers = LinkedHashSet<(AuthLens) -> Unit>()

    private val _denialEvents = MutableSharedFlow<FirebaseFirestoreException>(extraBufferCapacity = EVENT_BUFFER_CAPACITY)
    val denialEvents: SharedFlow<FirebaseFirestoreException> = _denialEvents.asSharedFlow()
    private val denialObservers = LinkedHashSet<(FirebaseFirestoreException) -> Unit>()

    fun publishConnectionState(
        next: BridgeConnectionState,
        closeError: FirebaseFirestoreException? = null
    ) {
        synchronized(connectionLock) {
            _connectionStates.value = next
            lastCloseError = if (next == BridgeConnectionState.CLOSED) closeError else null
            for (observer in connectionObservers) {
                observer.onStateChange(next, lastCloseError)
            }
        }
    }

    /**
     * Registers [observer] synchronously and delivers the current state under
     * [connectionLock] so no transition can be missed or reordered against init.
     */
    fun addConnectionStateObserver(observer: BridgeConnectionObserver): () -> Unit {
        synchronized(connectionLock) {
            connectionObservers.add(observer)
            observer.onStateChange(_connectionStates.value, lastCloseError)
        }
        return {
            synchronized(connectionLock) {
                connectionObservers.remove(observer)
            }
        }
    }

    fun publishRemoteLens(lens: AuthLens) {
        synchronized(lensLock) {
            lastRemoteLens = lens
            _remoteLensEvents.tryEmit(lens)
            for (observer in remoteLensObservers) {
                observer(lens)
            }
        }
    }

    fun addRemoteLensObserver(observer: (AuthLens) -> Unit): () -> Unit {
        synchronized(lensLock) {
            remoteLensObservers.add(observer)
            val replay = lastRemoteLens
            if (replay != null) {
                observer(replay)
            }
        }
        return {
            synchronized(lensLock) {
                remoteLensObservers.remove(observer)
            }
        }
    }

    private fun isRulesDenial(exception: FirebaseFirestoreException): Boolean {
        if (exception.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) return true
        if (exception.denialContext != null) return true
        val wire = exception.wireCode
        return wire.equals("storage/unauthorized", ignoreCase = true) ||
            wire.equals("unauthorized", ignoreCase = true)
    }

    fun dispatchDenial(exception: FirebaseFirestoreException) {
        if (!isRulesDenial(exception)) return
        synchronized(denialLock) {
            _denialEvents.tryEmit(exception)
            val snapshot = denialObservers.toList()
            if (snapshot.isNotEmpty()) {
                deliveryQueue.enqueue {
                    for (observer in snapshot) {
                        observer(exception)
                    }
                }
            }
        }
    }

    fun addDenialObserver(observer: (FirebaseFirestoreException) -> Unit): () -> Unit {
        synchronized(denialLock) {
            denialObservers.add(observer)
        }
        return {
            synchronized(denialLock) {
                denialObservers.remove(observer)
            }
        }
    }

    private companion object {
        // SharedFlow grows its array on demand starting from 2, so a large cap
        // avoids drops without upfront allocation or replay+cap Int overflow.
        const val EVENT_BUFFER_CAPACITY = 1 shl 20
    }
}
