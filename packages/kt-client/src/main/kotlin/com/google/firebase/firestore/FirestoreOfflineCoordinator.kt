package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

internal class FirestoreOfflineCoordinator(
    private val firestore: FirebaseFirestore,
    private val scope: CoroutineScope
) {
    private class PendingWriteEntry(
        val id: Long,
        val mutation: OfflineDocMutation,
        val sendOnline: suspend () -> Unit,
        val tcs: TaskCompletionSource<Void?> = TaskCompletionSource(),
        val barrier: CompletableDeferred<Unit> = CompletableDeferred(),
        val startedFlush: AtomicBoolean = AtomicBoolean(false)
    )

    private class InSyncRegistration(
        val executor: Executor?,
        val runnable: Runnable,
        val cancelled: AtomicBoolean = AtomicBoolean(false)
    ) {
        fun dispatch(fallbackScope: CoroutineScope) {
            if (cancelled.get()) return
            val runGuarded = Runnable {
                if (!cancelled.get()) {
                    try {
                        runnable.run()
                    } catch (_: Throwable) {}
                }
            }
            if (executor != null) {
                executor.execute(runGuarded)
            } else {
                fallbackScope.launch { runGuarded.run() }
            }
        }
    }

    private val lock = Any()
    private val nextWriteId = AtomicLong(1L)
    private val nextListenerId = AtomicLong(1L)
    private val memoryStore = ConcurrentHashMap<String, CachedDocState>()
    private val stagedWrites = LinkedHashMap<Long, PendingWriteEntry>()
    private val pendingWrites = LinkedHashMap<Long, PendingWriteEntry>()
    private val activeListenersSynced = ConcurrentHashMap<Long, Boolean>()
    private val inSyncListeners = CopyOnWriteArrayList<InSyncRegistration>()

    @Volatile
    var isNetworkEnabled: Boolean = true
        private set

    private val _listenerNetworkEnabledFlow = MutableStateFlow(true)
    val listenerNetworkEnabledFlow: StateFlow<Boolean> = _listenerNetworkEnabledFlow.asStateFlow()

    private val _cacheVersionFlow = MutableStateFlow(0L)
    val cacheVersionFlow: StateFlow<Long> = _cacheVersionFlow.asStateFlow()

    private fun backingStore(): ConcurrentHashMap<String, CachedDocState> {
        if (firestore.firestoreSettings.isPersistenceEnabled) {
            val key = Pair(firestore.app.name, firestore.databaseId)
            return persistedStores.computeIfAbsent(key) { ConcurrentHashMap() }
        }
        return memoryStore
    }

    fun recordServerDoc(
        path: String,
        exists: Boolean,
        data: Map<String, Any?>?,
        rawWireData: Map<String, Any?>?
    ) {
        val copied = if (exists && data != null) FirestoreOfflineProjection.deepCopyMap(data) else null
        synchronized(lock) {
            backingStore()[path] = CachedDocState(
                exists = exists,
                data = copied,
                rawWireData = if (exists) rawWireData else null
            )
            _cacheVersionFlow.value += 1L
        }
    }

    fun projectDocument(path: String): ProjectedDocState {
        val (base, mutations) = synchronized(lock) {
            backingStore()[path] to stagedWrites.values.map { it.mutation }
        }
        return FirestoreOfflineProjection.projectDocument(
            path = path,
            base = base,
            stagedMutations = mutations,
            resolveRef = { p -> firestore.unvalidatedDocumentRef(p) }
        )
    }

    fun submitWrite(
        mutation: OfflineDocMutation,
        sendOnline: suspend () -> Unit
    ): Task<Void?> {
        val entry = PendingWriteEntry(
            id = nextWriteId.getAndIncrement(),
            mutation = mutation,
            sendOnline = sendOnline
        )
        val sendNow = synchronized(lock) {
            stagedWrites[entry.id] = entry
            pendingWrites[entry.id] = entry
            _cacheVersionFlow.value += 1L
            isNetworkEnabled
        }

        if (sendNow) {
            // Undispatched so back-to-back online writes enqueue onto the bridge socket
            // on the caller's thread in exact call order (#1032).
            launchFlushUndispatched(entry)
        } else {
            notifyInSyncIfAllListenersSynced()
        }
        return entry.tcs.task
    }

    private fun launchFlushUndispatched(entry: PendingWriteEntry) {
        if (!entry.startedFlush.compareAndSet(false, true)) return
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                entry.sendOnline()
                synchronized(lock) {
                    stagedWrites.remove(entry.id)
                    pendingWrites.remove(entry.id)
                    val store = backingStore()
                    val updated = FirestoreOfflineProjection.applyCommittedMutation(
                        base = store[entry.mutation.path],
                        mutation = entry.mutation,
                        resolveRef = { p -> firestore.unvalidatedDocumentRef(p) }
                    )
                    store[entry.mutation.path] = updated
                    _cacheVersionFlow.value += 1L
                    if (isNetworkEnabled && stagedWrites.isEmpty() && !firestore.isTerminated) {
                        _listenerNetworkEnabledFlow.value = true
                    }
                }
                entry.tcs.trySetResult(null)
                entry.barrier.complete(Unit)
                notifyInSyncIfAllListenersSynced()
            } catch (e: Exception) {
                synchronized(lock) {
                    stagedWrites.remove(entry.id)
                    pendingWrites.remove(entry.id)
                    _cacheVersionFlow.value += 1L
                    if (isNetworkEnabled && stagedWrites.isEmpty() && !firestore.isTerminated) {
                        _listenerNetworkEnabledFlow.value = true
                    }
                }
                entry.tcs.trySetException(e)
                entry.barrier.complete(Unit)
                notifyInSyncIfAllListenersSynced()
            }
        }
    }

    fun disableNetwork(): Task<Void?> {
        firestore.ensureClientActive()
        synchronized(lock) {
            isNetworkEnabled = false
            _listenerNetworkEnabledFlow.value = false
        }
        return Tasks.forResult(null)
    }

    fun enableNetwork(): Task<Void?> {
        firestore.ensureClientActive()
        val toFlush = synchronized(lock) {
            isNetworkEnabled = true
            if (stagedWrites.isEmpty()) {
                _listenerNetworkEnabledFlow.value = true
            }
            stagedWrites.values.toList()
        }
        if (toFlush.isEmpty()) {
            notifyInSyncIfAllListenersSynced()
            return Tasks.forResult(null)
        }
        // Start every queued write undispatched on the caller's thread so its frame is
        // enqueued on PyricBridgeClient in FIFO order before any subsequent online write.
        for (entry in toFlush) {
            launchFlushUndispatched(entry)
        }
        val tcs = TaskCompletionSource<Void?>()
        val remaining = AtomicInteger(toFlush.size)
        for (entry in toFlush) {
            entry.barrier.invokeOnCompletion {
                if (remaining.decrementAndGet() == 0) {
                    synchronized(lock) {
                        if (isNetworkEnabled && stagedWrites.isEmpty() && !firestore.isTerminated) {
                            _listenerNetworkEnabledFlow.value = true
                        }
                    }
                    tcs.trySetResult(null)
                    notifyInSyncIfAllListenersSynced()
                }
            }
        }
        return tcs.task
    }

    fun waitForPendingWrites(): Task<Void?> {
        firestore.ensureClientActive()
        val barriers = synchronized(lock) {
            pendingWrites.values.map { it.barrier }
        }
        if (barriers.isEmpty()) {
            return Tasks.forResult(null)
        }
        val tcs = TaskCompletionSource<Void?>()
        val remaining = AtomicInteger(barriers.size)
        for (b in barriers) {
            b.invokeOnCompletion {
                if (remaining.decrementAndGet() == 0) {
                    tcs.trySetResult(null)
                }
            }
        }
        return tcs.task
    }

    fun clearPersistence(): Task<Void?> {
        if (firestore.isStarted && !firestore.isTerminated) {
            return Tasks.forException(
                FirebaseFirestoreException(
                    "Persistence cannot be cleared while the firestore instance is running.",
                    FirebaseFirestoreException.Code.FAILED_PRECONDITION
                )
            )
        }
        synchronized(lock) {
            memoryStore.clear()
            persistedStores.remove(Pair(firestore.app.name, firestore.databaseId))
            stagedWrites.clear()
            pendingWrites.clear()
            _cacheVersionFlow.value += 1L
        }
        return Tasks.forResult(null)
    }

    fun registerActiveListener(): Long {
        val id = nextListenerId.getAndIncrement()
        activeListenersSynced[id] = false
        return id
    }

    fun markListenerOutOfSync(listenerId: Long) {
        if (activeListenersSynced.containsKey(listenerId)) {
            activeListenersSynced[listenerId] = false
        }
    }

    fun markListenerSyncedAndNotify(listenerId: Long, forceNotify: Boolean = false) {
        val transitioned = activeListenersSynced.replace(listenerId, false, true)
        if (transitioned || forceNotify) {
            notifyInSyncIfAllListenersSynced()
        }
    }

    fun unregisterActiveListener(listenerId: Long) {
        activeListenersSynced.remove(listenerId)
    }

    fun addSnapshotsInSyncListener(executor: Executor?, runnable: Runnable): ListenerRegistration {
        firestore.ensureClientActive()
        val reg = InSyncRegistration(executor = executor, runnable = runnable)
        inSyncListeners.add(reg)
        if (areAllListenersSynced()) {
            reg.dispatch(scope)
        }
        return ListenerRegistration {
            reg.cancelled.set(true)
            inSyncListeners.remove(reg)
        }
    }

    private fun areAllListenersSynced(): Boolean =
        activeListenersSynced.values.all { it }

    fun notifyInSyncIfAllListenersSynced() {
        if (firestore.isTerminated) return
        if (!areAllListenersSynced()) return
        for (reg in inSyncListeners) {
            reg.dispatch(scope)
        }
    }

    fun onTerminate() {
        inSyncListeners.forEach { it.cancelled.set(true) }
        inSyncListeners.clear()
        activeListenersSynced.clear()
        val abandoned = synchronized(lock) {
            memoryStore.clear()
            val list = pendingWrites.values.toList()
            stagedWrites.clear()
            pendingWrites.clear()
            list
        }
        val terminatedEx = FirebaseFirestoreException(
            "The Firestore client has been terminated.",
            FirebaseFirestoreException.Code.ABORTED
        )
        for (entry in abandoned) {
            entry.tcs.trySetException(terminatedEx)
            entry.barrier.complete(Unit)
        }
    }

    companion object {
        private val persistedStores =
            ConcurrentHashMap<Pair<String, String>, ConcurrentHashMap<String, CachedDocState>>()

        fun clearAllPersistedStoresForTest() {
            persistedStores.clear()
        }
    }
}
