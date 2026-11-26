package com.google.firebase.database

import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.BridgeFlowHandoff
import dev.pyric.bridge.BridgeSubscriptionGap
import dev.pyric.bridge.BridgeSubscriptionHandle
import dev.pyric.database.internal.InfoListenerHandle
import dev.pyric.database.internal.isInfoPath
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Synchronous registration for Realtime Database listeners and flows.
 *
 * Host paths open their [BridgeSubscriptionHandle] on the caller's thread before
 * returning (D7) and deliver snapshots directly on `bridgeClient.deliveryQueue`
 * without bounded intermediate `callbackFlow` buffers (D8). `.info` paths bind
 * synchronously to [FirebaseDatabase.infoHub] (K12, K15).
 */
internal class RtdbSnapshotRegistration(
    private val query: Query,
    scope: CoroutineScope,
    private val singleEvent: Boolean,
    private val onSnapshot: (DataSnapshot) -> Unit,
    private val onError: (Throwable) -> Unit,
    private val onImmediateClose: ((Throwable) -> Unit)? = null
) {
    private val lock = Any()
    @Volatile private var active: Boolean = true
    private val ended = AtomicBoolean(false)
    private val generation = AtomicLong(0)
    private var currentHandle: BridgeSubscriptionHandle? = null
    private var infoHandle: InfoListenerHandle? = null
    private var lensMonitorJob: Job? = null

    init {
        if (isInfoPath(query.path)) {
            val created = query.database.infoHub.registerListener(
                path = query.path,
                onValue = { raw ->
                    if (!active) return@registerListener
                    val snap = DataSnapshot(query.ref, raw)
                    if (singleEvent) {
                        cancel()
                    }
                    onSnapshot(snap)
                },
                onCloseError = { err -> deliverErrorOnce(err) },
                onImmediateClose = { err ->
                    active = false
                    onImmediateClose?.invoke(err)
                }
            )
            val cancelImmediately = synchronized(lock) {
                if (!active) true else {
                    infoHandle = created
                    false
                }
            }
            if (cancelImmediately) created.cancel()
        } else {
            val target = buildHostTarget(query)
            val initialLens = query.database.getEffectiveAuthLens()
            openHostSubscription(target, initialLens)
            val job = scope.launch {
                var lastLens = initialLens
                query.database.authLensFlow.collect { newLens ->
                    if (!active) throw CancellationException("RTDB registration cancelled")
                    if (newLens != lastLens) {
                        lastLens = newLens
                        openHostSubscription(target, newLens)
                    }
                }
            }
            val cancelJob = synchronized(lock) {
                if (!active) {
                    true
                } else {
                    lensMonitorJob = job
                    false
                }
            }
            if (cancelJob) {
                job.cancel()
            }
        }
    }

    private fun openHostSubscription(target: Map<String, Any?>, lens: AuthLens) {
        val gen = generation.incrementAndGet()
        val previous = synchronized(lock) {
            if (!active) return
            val old = currentHandle
            currentHandle = null
            old
        }
        previous?.cancel()

        val handle = try {
            query.database.bridgeClient.openSubscription(
                target = target,
                actAs = lens.toMap(),
                onValue = { raw ->
                    if (!active || generation.get() != gen) return@openSubscription
                    if (raw === BridgeSubscriptionGap) return@openSubscription
                    @Suppress("UNCHECKED_CAST")
                    val wire = raw as? Map<String, Any?>
                    val snap = DataSnapshot.fromWire(query.ref, wire)
                    if (singleEvent) {
                        cancel()
                    }
                    onSnapshot(snap)
                },
                onWireError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    cancel()
                    deliverErrorOnce(err)
                },
                onCloseError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    cancel()
                    onImmediateClose?.invoke(err)
                    query.database.bridgeClient.deliveryQueue.enqueue {
                        deliverErrorOnce(err)
                    }
                }
            )
        } catch (e: FirebaseFirestoreException) {
            cancel()
            onImmediateClose?.invoke(e)
            query.database.bridgeClient.deliveryQueue.enqueue {
                deliverErrorOnce(e)
            }
            return
        }

        val cancelImmediately = synchronized(lock) {
            if (!active || generation.get() != gen) {
                true
            } else {
                currentHandle = handle
                false
            }
        }
        if (cancelImmediately) {
            handle.cancel()
        }
    }

    private fun deliverErrorOnce(error: Throwable) {
        cancel()
        if (ended.compareAndSet(false, true)) {
            onError(error)
        }
    }

    fun cancel() {
        val handleToCancel: BridgeSubscriptionHandle?
        val infoToCancel: InfoListenerHandle?
        val jobToCancel: Job?
        synchronized(lock) {
            active = false
            generation.incrementAndGet()
            handleToCancel = currentHandle
            currentHandle = null
            infoToCancel = infoHandle
            infoHandle = null
            jobToCancel = lensMonitorJob
            lensMonitorJob = null
        }
        jobToCancel?.cancel()
        infoToCancel?.cancel()
        handleToCancel?.cancel()
    }

    companion object {
        private fun buildHostTarget(query: Query): Map<String, Any?> {
            val target = mutableMapOf<String, Any?>(
                "service" to "rtdb",
                "path" to query.path
            )
            val instance = query.database.wireInstance
            if (instance != null) {
                target["instance"] = instance
            }
            if (!query.querySpec.isEmpty()) {
                target["query"] = query.querySpec.toMap()
            }
            return target
        }

        fun registerChildListener(
            query: Query,
            scope: CoroutineScope,
            listener: ChildEventListener
        ): RtdbSnapshotRegistration {
            // Mutated exclusively on bridgeClient.deliveryQueue.
            var previousChildren: Map<String, DataSnapshot>? = null
            lateinit var registration: RtdbSnapshotRegistration
            registration = RtdbSnapshotRegistration(
                query = query,
                scope = scope,
                singleEvent = false,
                onSnapshot = { snapshot ->
                    val currentList = snapshot.children.toList()
                    val events = diffChildSnapshots(previousChildren, currentList, query.querySpec)
                    previousChildren = currentList.associateBy { it.key ?: "" }
                    for (event in events) {
                        if (!registration.active) break
                        when (event) {
                            is ChildEvent.Added -> listener.onChildAdded(event.snapshot, event.previousChildName)
                            is ChildEvent.Changed -> listener.onChildChanged(event.snapshot, event.previousChildName)
                            is ChildEvent.Removed -> listener.onChildRemoved(event.snapshot)
                            is ChildEvent.Moved -> listener.onChildMoved(event.snapshot, event.previousChildName)
                        }
                    }
                },
                onError = { err ->
                    listener.onCancelled(DatabaseError.fromException(err))
                }
            )
            return registration
        }

        fun snapshotsFlow(query: Query, scope: CoroutineScope): Flow<DataSnapshot> = flow {
            val handoff = BridgeFlowHandoff<DataSnapshot>()
            val registration = RtdbSnapshotRegistration(
                query = query,
                scope = scope,
                singleEvent = false,
                onSnapshot = handoff::deliverValue,
                onError = handoff::deliverError,
                onImmediateClose = handoff::failImmediate
            )
            try {
                handoff.collectLoop(this)
            } finally {
                handoff.cancel()
                registration.cancel()
            }
        }

        fun childEventsFlow(query: Query, scope: CoroutineScope): Flow<ChildEvent> = flow {
            val handoff = BridgeFlowHandoff<ChildEvent>()
            var previousChildren: Map<String, DataSnapshot>? = null
            val registration = RtdbSnapshotRegistration(
                query = query,
                scope = scope,
                singleEvent = false,
                onSnapshot = { snapshot ->
                    val currentList = snapshot.children.toList()
                    val events = diffChildSnapshots(previousChildren, currentList, query.querySpec)
                    previousChildren = currentList.associateBy { it.key ?: "" }
                    for (event in events) {
                        handoff.deliverValue(event)
                    }
                },
                onError = handoff::deliverError,
                onImmediateClose = handoff::failImmediate
            )
            try {
                handoff.collectLoop(this)
            } finally {
                handoff.cancel()
                registration.cancel()
            }
        }
    }
}
