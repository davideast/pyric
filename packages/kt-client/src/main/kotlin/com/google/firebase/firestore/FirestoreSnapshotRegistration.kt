package com.google.firebase.firestore

import dev.pyric.auth.AuthLens
import dev.pyric.bridge.BridgeFlowHandoff
import dev.pyric.bridge.BridgeSubscriptionGap
import dev.pyric.bridge.BridgeSubscriptionHandle
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Synchronous snapshot registration for [DocumentReference].
 *
 * Registers with `bridgeClient` on the caller's thread before returning (D7)
 * when online, and serializes remote wire frames, gap markers, and local cache
 * overlay projections onto `bridgeClient.deliveryQueue` so cross-subscription
 * frame order holds (D8) and cache ticks never overtake newer remote frames.
 */
internal class DocumentSnapshotRegistration(
    private val docRef: DocumentReference,
    private val includeMetadata: Boolean,
    private val onSnapshot: (DocumentSnapshot) -> Unit,
    private val onError: (FirebaseFirestoreException) -> Unit,
    private val onComplete: () -> Unit = {},
    private val onImmediateClose: ((FirebaseFirestoreException) -> Unit)? = null
) : ListenerRegistration {
    private val firestore = docRef.firestore
    private val deliveryQueue = firestore.bridgeClient.deliveryQueue
    private val target = mapOf("__ref" to "doc", "path" to docRef.path)
    private val lock = Any()
    private val listenerId = firestore.offlineCoordinator.registerActiveListener()
    private val generation = AtomicLong(0)
    private val ended = AtomicBoolean(false)

    @Volatile private var active = true
    private var currentHandle: BridgeSubscriptionHandle? = null
    private var stateMonitorJob: Job? = null
    private var cacheMonitorJob: Job? = null
    private var unregisterTermination: (() -> Unit)? = null

    // Mutated exclusively on deliveryQueue.
    private var lastDelivered: DocumentSnapshot? = null
    private var rawGeneration: Long = -1L
    private var lastRaw: Any? = null
    private var offlineMode: Boolean = false

    init {
        val initialLens = firestore.getEffectiveAuthLens()
        val initialTerminated = firestore.isTerminated
        val initialNetwork = firestore.offlineCoordinator.listenerNetworkEnabledFlow.value
        val initialCacheVersion = firestore.offlineCoordinator.cacheVersionFlow.value

        if (initialTerminated) {
            completeTerminal()
        } else {
            if (initialNetwork) {
                switchToOnline(initialLens)
            } else {
                switchToOffline()
            }
            startMonitors(initialLens, initialTerminated, initialNetwork, initialCacheVersion)
        }
    }

    private fun startMonitors(
        initialLens: AuthLens,
        initialTerminated: Boolean,
        initialNetwork: Boolean,
        initialCacheVersion: Long
    ) {
        val scope = firestore.listenerScope
        val stateJob = scope.launch {
            var last = Triple(initialLens, initialTerminated, initialNetwork)
            combine(
                firestore.authLensFlow,
                firestore.terminatedStateFlow,
                firestore.offlineCoordinator.listenerNetworkEnabledFlow
            ) { lens, terminated, networkEnabled ->
                Triple(lens, terminated, networkEnabled)
            }.collect { next ->
                if (!active) return@collect
                if (next == last) return@collect
                last = next
                val (lens, terminated, networkEnabled) = next
                if (terminated) {
                    completeTerminal()
                } else if (networkEnabled) {
                    switchToOnline(lens)
                } else {
                    switchToOffline()
                }
            }
        }
        val cacheJob = scope.launch {
            var lastVersion = initialCacheVersion
            firestore.offlineCoordinator.cacheVersionFlow.collect { version ->
                if (!active || version == lastVersion) return@collect
                lastVersion = version
                val gen = generation.get()
                deliveryQueue.enqueue {
                    if (!active || generation.get() != gen) return@enqueue
                    val candidate = if (offlineMode) {
                        val proj = firestore.offlineCoordinator.projectDocument(docRef.path)
                        docRef.snapshotFromProjection(proj, isFromCache = true)
                    } else if (rawGeneration == gen) {
                        val proj = firestore.offlineCoordinator.projectDocument(docRef.path)
                        if (proj.known) docRef.snapshotFromProjection(proj, isFromCache = false) else null
                    } else {
                        null
                    }
                    if (candidate != null) maybeEmitOnQueue(candidate)
                }
            }
        }
        val unregisterTerm = firestore.addTerminationObserver(::completeTerminal)
        val cancelJobs = synchronized(lock) {
            if (!active) {
                true
            } else {
                stateMonitorJob = stateJob
                cacheMonitorJob = cacheJob
                unregisterTermination = unregisterTerm
                false
            }
        }
        if (cancelJobs) {
            unregisterTerm()
            stateJob.cancel()
            cacheJob.cancel()
        }
    }

    private fun switchToOffline() {
        val gen = generation.incrementAndGet()
        val previous = synchronized(lock) {
            if (!active) return
            currentHandle.also { currentHandle = null }
        }
        previous?.cancel()
        deliveryQueue.enqueue {
            if (!active || generation.get() != gen) return@enqueue
            offlineMode = true
            rawGeneration = -1L
            lastRaw = null
            val proj = firestore.offlineCoordinator.projectDocument(docRef.path)
            maybeEmitOnQueue(docRef.snapshotFromProjection(proj, isFromCache = true))
        }
    }

    private fun switchToOnline(lens: AuthLens) {
        val gen = generation.incrementAndGet()
        val previous = synchronized(lock) {
            if (!active) return
            currentHandle.also { currentHandle = null }
        }
        previous?.cancel()
        firestore.offlineCoordinator.markListenerOutOfSync(listenerId)
        deliveryQueue.enqueue {
            if (!active || generation.get() != gen) return@enqueue
            offlineMode = false
        }
        val handle = try {
            firestore.bridgeClient.openSubscription(
                target = target,
                actAs = lens.toMap(),
                includeMetadataChanges = includeMetadata,
                onValue = { rawMsg ->
                    if (!active || generation.get() != gen) return@openSubscription
                    val candidate = if (rawMsg === BridgeSubscriptionGap) {
                        if (rawGeneration == gen) docRef.snapshotFromWire(lastRaw, isFromCache = true) else null
                    } else {
                        rawGeneration = gen
                        lastRaw = rawMsg
                        docRef.snapshotFromWireAndCache(rawMsg)
                    }
                    if (candidate != null) maybeEmitOnQueue(candidate)
                },
                onWireError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    active = false
                    deliverErrorOnce(err)
                },
                onCloseError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    active = false
                    onImmediateClose?.invoke(err)
                    deliveryQueue.enqueue { deliverErrorOnce(err) }
                }
            )
        } catch (e: FirebaseFirestoreException) {
            active = false
            onImmediateClose?.invoke(e)
            deliveryQueue.enqueue { deliverErrorOnce(e) }
            return
        }
        val cancelNow = synchronized(lock) {
            if (!active || generation.get() != gen) {
                true
            } else {
                currentHandle = handle
                false
            }
        }
        if (cancelNow) handle.cancel()
    }

    private fun maybeEmitOnQueue(candidate: DocumentSnapshot) {
        if (!active) return
        val prev = lastDelivered
        val shouldEmit = if (prev == null) {
            true
        } else {
            val dataChanged = prev.exists() != candidate.exists() ||
                !FirestoreOfflineProjection.valuesEqual(prev.getData(), candidate.getData())
            val metaChanged = includeMetadata && prev.metadata != candidate.metadata
            dataChanged || metaChanged
        }
        if (shouldEmit) {
            lastDelivered = candidate
            onSnapshot(candidate)
        }
        if (!candidate.metadata.isFromCache && !candidate.metadata.hasPendingWrites) {
            firestore.offlineCoordinator.markListenerSyncedAndNotify(listenerId, forceNotify = shouldEmit)
        } else {
            firestore.offlineCoordinator.markListenerOutOfSync(listenerId)
        }
    }

    private fun deliverErrorOnce(err: FirebaseFirestoreException) {
        if (ended.compareAndSet(false, true)) {
            cleanupResources()
            onError(err)
        }
    }

    private fun completeTerminal() {
        cleanupResources()
        if (ended.compareAndSet(false, true)) {
            onComplete()
        }
    }

    private fun cleanupResources() {
        val handle: BridgeSubscriptionHandle?
        val sJob: Job?
        val cJob: Job?
        val unregisterTerm: (() -> Unit)?
        synchronized(lock) {
            active = false
            generation.incrementAndGet()
            handle = currentHandle; currentHandle = null
            sJob = stateMonitorJob; stateMonitorJob = null
            cJob = cacheMonitorJob; cacheMonitorJob = null
            unregisterTerm = unregisterTermination; unregisterTermination = null
        }
        unregisterTerm?.invoke()
        sJob?.cancel()
        cJob?.cancel()
        handle?.cancel()
        firestore.offlineCoordinator.unregisterActiveListener(listenerId)
    }

    override fun remove() {
        cleanupResources()
    }

    companion object {
        fun snapshotsFlow(docRef: DocumentReference, includeMetadata: Boolean): Flow<DocumentSnapshot> = flow {
            val handoff = BridgeFlowHandoff<DocumentSnapshot>()
            val registration = DocumentSnapshotRegistration(
                docRef = docRef,
                includeMetadata = includeMetadata,
                onSnapshot = handoff::deliverValue,
                onError = handoff::deliverError,
                onComplete = handoff::deliverComplete,
                onImmediateClose = handoff::failImmediate
            )
            try {
                handoff.collectLoop(this)
            } finally {
                handoff.cancel()
                registration.remove()
            }
        }
    }
}

/**
 * Synchronous snapshot registration for Firestore [Query].
 */
internal class QuerySnapshotRegistration(
    private val query: Query,
    private val target: Map<String, Any?>,
    private val includeMetadata: Boolean,
    private val onSnapshot: (QuerySnapshot) -> Unit,
    private val onError: (FirebaseFirestoreException) -> Unit,
    private val onComplete: () -> Unit = {},
    private val onImmediateClose: ((FirebaseFirestoreException) -> Unit)? = null
) : ListenerRegistration {
    private val firestore = query.firestore
    private val deliveryQueue = firestore.bridgeClient.deliveryQueue
    private val lock = Any()
    private val generation = AtomicLong(0)
    private val ended = AtomicBoolean(false)

    @Volatile private var active = true
    private var currentHandle: BridgeSubscriptionHandle? = null
    private var stateMonitorJob: Job? = null
    private var unregisterTermination: (() -> Unit)? = null

    // Mutated exclusively on deliveryQueue.
    private var previousDocs: List<QueryDocumentSnapshot>? = null
    private var rawGeneration: Long = -1L
    private var lastRaw: Any? = null

    init {
        val initialLens = firestore.getEffectiveAuthLens()
        val initialTerminated = firestore.isTerminated
        if (initialTerminated) {
            completeTerminal()
        } else {
            openRemote(initialLens)
            val job = firestore.listenerScope.launch {
                var last = initialLens to initialTerminated
                combine(firestore.authLensFlow, firestore.terminatedStateFlow) { lens, terminated ->
                    lens to terminated
                }.collect { next ->
                    if (!active || next == last) return@collect
                    last = next
                    if (next.second) {
                        completeTerminal()
                    } else {
                        openRemote(next.first)
                    }
                }
            }
            val unregisterTerm = firestore.addTerminationObserver(::completeTerminal)
            val cancelNow = synchronized(lock) {
                if (!active) true else {
                    stateMonitorJob = job
                    unregisterTermination = unregisterTerm
                    false
                }
            }
            if (cancelNow) {
                unregisterTerm()
                job.cancel()
            }
        }
    }

    private fun openRemote(lens: AuthLens) {
        val gen = generation.incrementAndGet()
        val previous = synchronized(lock) {
            if (!active) return
            currentHandle.also { currentHandle = null }
        }
        previous?.cancel()
        val handle = try {
            firestore.bridgeClient.openSubscription(
                target = target,
                actAs = lens.toMap(),
                includeMetadataChanges = includeMetadata,
                onValue = { rawMsg ->
                    if (!active || generation.get() != gen) return@openSubscription
                    val snapshot = if (rawMsg === BridgeSubscriptionGap) {
                        if (rawGeneration == gen) {
                            query.snapshotFromWire(lastRaw, isFromCache = true, previousDocs = previousDocs, includeMetadata = includeMetadata)
                        } else {
                            null
                        }
                    } else {
                        rawGeneration = gen
                        lastRaw = rawMsg
                        @Suppress("UNCHECKED_CAST")
                        val wireDocs = (rawMsg as? Map<String, Any?>)?.get("docs") as? List<Map<String, Any?>>
                        if (wireDocs != null) {
                            QueryCacheStore.put(firestore, target, wireDocs)
                        }
                        query.snapshotFromWire(rawMsg, isFromCache = false, previousDocs = previousDocs, includeMetadata = includeMetadata)
                    }
                    if (snapshot != null && active) {
                        previousDocs = snapshot.documents.filterIsInstance<QueryDocumentSnapshot>()
                        onSnapshot(snapshot)
                    }
                },
                onWireError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    active = false
                    deliverErrorOnce(err)
                },
                onCloseError = { err ->
                    if (generation.get() != gen) return@openSubscription
                    active = false
                    onImmediateClose?.invoke(err)
                    deliveryQueue.enqueue { deliverErrorOnce(err) }
                }
            )
        } catch (e: FirebaseFirestoreException) {
            active = false
            onImmediateClose?.invoke(e)
            deliveryQueue.enqueue { deliverErrorOnce(e) }
            return
        }
        val cancelNow = synchronized(lock) {
            if (!active || generation.get() != gen) {
                true
            } else {
                currentHandle = handle
                false
            }
        }
        if (cancelNow) handle.cancel()
    }

    private fun deliverErrorOnce(err: FirebaseFirestoreException) {
        if (ended.compareAndSet(false, true)) {
            cleanupResources()
            onError(err)
        }
    }

    private fun completeTerminal() {
        cleanupResources()
        if (ended.compareAndSet(false, true)) {
            onComplete()
        }
    }

    private fun cleanupResources() {
        val handle: BridgeSubscriptionHandle?
        val job: Job?
        val unregisterTerm: (() -> Unit)?
        synchronized(lock) {
            active = false
            generation.incrementAndGet()
            handle = currentHandle; currentHandle = null
            job = stateMonitorJob; stateMonitorJob = null
            unregisterTerm = unregisterTermination; unregisterTermination = null
        }
        unregisterTerm?.invoke()
        job?.cancel()
        handle?.cancel()
    }

    override fun remove() {
        cleanupResources()
    }

    companion object {
        fun snapshotsFlow(query: Query, target: Map<String, Any?>, includeMetadata: Boolean): Flow<QuerySnapshot> = flow {
            val handoff = BridgeFlowHandoff<QuerySnapshot>()
            val registration = QuerySnapshotRegistration(
                query = query,
                target = target,
                includeMetadata = includeMetadata,
                onSnapshot = handoff::deliverValue,
                onError = handoff::deliverError,
                onComplete = handoff::deliverComplete,
                onImmediateClose = handoff::failImmediate
            )
            try {
                handoff.collectLoop(this)
            } finally {
                handoff.cancel()
                registration.remove()
            }
        }
    }
}
