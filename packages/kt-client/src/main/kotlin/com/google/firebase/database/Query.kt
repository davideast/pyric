package com.google.firebase.database

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.BridgeSubscriptionGap
import dev.pyric.database.internal.infoValue
import dev.pyric.database.internal.infoValues
import dev.pyric.database.internal.isConnected
import dev.pyric.database.internal.isInfoPath
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

data class RtdbQuerySpec(
    val orderBy: Map<String, Any?>? = null,
    val bounds: List<Map<String, Any?>> = emptyList(),
    val limit: Map<String, Any?>? = null
) {
    fun isEmpty(): Boolean = orderBy == null && bounds.isEmpty() && limit == null

    internal fun hasStartBound(): Boolean = bounds.any {
        val kind = it["kind"]
        kind == "startAt" || kind == "startAfter" || kind == "equalTo"
    }

    internal fun hasEndBound(): Boolean = bounds.any {
        val kind = it["kind"]
        kind == "endAt" || kind == "endBefore" || kind == "equalTo"
    }

    fun toMap(): Map<String, Any?> {
        return mapOf(
            "orderBy" to orderBy,
            "bounds" to bounds,
            "limit" to limit
        )
    }
}

open class Query(
    val database: FirebaseDatabase,
    val path: String,
    internal val querySpec: RtdbQuerySpec = RtdbQuerySpec()
) {
    private val queryScope = CoroutineScope(Dispatchers.IO)
    private val valueListeners = ConcurrentHashMap<ValueEventListener, Job>()
    private val childListeners = ConcurrentHashMap<ChildEventListener, Job>()

    val ref: DatabaseReference
        get() = DatabaseReference(database, path)

    fun orderByChild(childPath: String): Query {
        val clean = childPath.trim('/').split('/').filter { it.isNotEmpty() }.joinToString("/")
        require(clean.isNotEmpty()) { "orderByChild path cannot be empty!" }
        require(querySpec.orderBy == null) { "You can't combine multiple orderBy calls!" }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "child", "path" to clean))
        )
    }

    fun orderByKey(): Query {
        require(querySpec.orderBy == null) { "You can't combine multiple orderBy calls!" }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "key"))
        )
    }

    fun orderByValue(): Query {
        require(querySpec.orderBy == null) { "You can't combine multiple orderBy calls!" }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "value"))
        )
    }

    fun orderByPriority(): Query {
        require(querySpec.orderBy == null) { "You can't combine multiple orderBy calls!" }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "priority"))
        )
    }

    @JvmOverloads
    fun equalTo(value: Any?, key: String? = null): Query {
        require(!querySpec.hasStartBound() && !querySpec.hasEndBound()) {
            "Can't call equalTo() after startAt(), startAfter(), endAt(), endBefore(), or equalTo()!"
        }
        if (querySpec.orderBy?.get("kind") == "key") {
            require(key == null) { "Can't pass a key cursor to equalTo() on an orderByKey() query!" }
        }
        val bound = mutableMapOf<String, Any?>("kind" to "equalTo", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    @JvmOverloads
    fun startAt(value: Any?, key: String? = null): Query {
        require(!querySpec.hasStartBound()) {
            "Can't call startAt() after startAt(), startAfter(), or equalTo()!"
        }
        if (querySpec.orderBy?.get("kind") == "key") {
            require(key == null) { "Can't pass a key cursor to startAt() on an orderByKey() query!" }
        }
        val bound = mutableMapOf<String, Any?>("kind" to "startAt", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    @JvmOverloads
    fun startAfter(value: Any?, key: String? = null): Query {
        require(!querySpec.hasStartBound()) {
            "Can't call startAfter() after startAt(), startAfter(), or equalTo()!"
        }
        if (querySpec.orderBy?.get("kind") == "key") {
            require(key == null) { "Can't pass a key cursor to startAfter() on an orderByKey() query!" }
        }
        val bound = mutableMapOf<String, Any?>("kind" to "startAfter", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    @JvmOverloads
    fun endAt(value: Any?, key: String? = null): Query {
        require(!querySpec.hasEndBound()) {
            "Can't call endAt() after endAt(), endBefore(), or equalTo()!"
        }
        if (querySpec.orderBy?.get("kind") == "key") {
            require(key == null) { "Can't pass a key cursor to endAt() on an orderByKey() query!" }
        }
        val bound = mutableMapOf<String, Any?>("kind" to "endAt", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    @JvmOverloads
    fun endBefore(value: Any?, key: String? = null): Query {
        require(!querySpec.hasEndBound()) {
            "Can't call endBefore() after endAt(), endBefore(), or equalTo()!"
        }
        if (querySpec.orderBy?.get("kind") == "key") {
            require(key == null) { "Can't pass a key cursor to endBefore() on an orderByKey() query!" }
        }
        val bound = mutableMapOf<String, Any?>("kind" to "endBefore", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun limitToFirst(limit: Int): Query {
        require(limit > 0) { "Limit must be a positive integer!" }
        require(querySpec.limit == null) {
            "Can't call limitToFirst on query with previously set limit!"
        }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(limit = mapOf("kind" to "limitToFirst", "n" to limit))
        )
    }

    fun limitToLast(limit: Int): Query {
        require(limit > 0) { "Limit must be a positive integer!" }
        require(querySpec.limit == null) {
            "Can't call limitToLast on query with previously set limit!"
        }
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(limit = mapOf("kind" to "limitToLast", "n" to limit))
        )
    }

    fun get(): Task<DataSnapshot> {
        val tcs = TaskCompletionSource<DataSnapshot>()
        if (isInfoPath(path)) {
            tcs.setResult(DataSnapshot(ref, infoValue(path, currentlyConnected())))
            return tcs.task
        }
        queryScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                val params = mutableMapOf<String, Any?>("path" to path)
                if (!querySpec.isEmpty()) {
                    params["query"] = querySpec.toMap()
                }
                val res = database.bridgeClient.op(
                    method = "rtdb.get",
                    params = database.withInstance(params),
                    actAs = database.getEffectiveAuthLens().toMap()
                )
                @Suppress("UNCHECKED_CAST")
                val wire = res as? Map<String, Any?>
                tcs.setResult(DataSnapshot.fromWire(ref, wire))
            } catch (e: Exception) {
                tcs.setException(DatabaseError.wrapTaskException(e))
            }
        }
        return tcs.task
    }

    fun addValueEventListener(listener: ValueEventListener): ValueEventListener {
        val job = queryScope.launch {
            try {
                snapshotsFlow().collect { snap ->
                    listener.onDataChange(snap)
                }
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    listener.onCancelled(DatabaseError.fromException(e))
                }
            }
        }
        valueListeners[listener] = job
        return listener
    }

    fun addListenerForSingleValueEvent(listener: ValueEventListener) {
        queryScope.launch {
            try {
                val snap = snapshotsFlow().first()
                listener.onDataChange(snap)
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    listener.onCancelled(DatabaseError.fromException(e))
                }
            }
        }
    }

    fun addChildEventListener(listener: ChildEventListener): ChildEventListener {
        val job = queryScope.launch {
            try {
                childEventsFlow().collect { event ->
                    when (event) {
                        is ChildEvent.Added -> listener.onChildAdded(event.snapshot, event.previousChildName)
                        is ChildEvent.Changed -> listener.onChildChanged(event.snapshot, event.previousChildName)
                        is ChildEvent.Removed -> listener.onChildRemoved(event.snapshot)
                        is ChildEvent.Moved -> listener.onChildMoved(event.snapshot, event.previousChildName)
                    }
                }
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    listener.onCancelled(DatabaseError.fromException(e))
                }
            }
        }
        childListeners[listener] = job
        return listener
    }

    fun removeEventListener(listener: ValueEventListener) {
        valueListeners.remove(listener)?.cancel()
    }

    fun removeEventListener(listener: ChildEventListener) {
        childListeners.remove(listener)?.cancel()
    }

    private fun currentlyConnected(): Boolean =
        isConnected(database.bridgeClient.connectionState, database.networkEnabled.value)

    /** Paths under `/.info` are served by the client; every other path is a host subscription. */
    internal fun snapshotsFlow(): Flow<DataSnapshot> =
        if (isInfoPath(path)) infoSnapshots() else hostSnapshots()

    private fun infoSnapshots(): Flow<DataSnapshot> =
        infoValues(path, database.bridgeClient.connectionStates, database.networkEnabled)
            .map { value -> DataSnapshot(ref, value) }

    private fun hostSnapshots(): Flow<DataSnapshot> = callbackFlow {
        val target = mutableMapOf<String, Any?>(
            "service" to "rtdb",
            "path" to path
        )
        val instance = database.wireInstance
        if (instance != null) {
            target["instance"] = instance
        }
        if (!querySpec.isEmpty()) {
            target["query"] = querySpec.toMap()
        }

        var activeJob: Job? = null

        fun startSubscription(lens: AuthLens) {
            activeJob?.cancel()
            activeJob = launch {
                try {
                    database.bridgeClient.subscribe(
                        target = target,
                        actAs = lens.toMap()
                    ).collect { raw ->
                        if (raw === BridgeSubscriptionGap) return@collect
                        @Suppress("UNCHECKED_CAST")
                        val wire = raw as? Map<String, Any?>
                        val snapshot = DataSnapshot.fromWire(ref, wire)
                        trySend(snapshot)
                    }
                } catch (e: Exception) {
                    if (e !is CancellationException) {
                        close(e)
                    }
                }
            }
        }

        startSubscription(database.getEffectiveAuthLens())

        val lensMonitorJob = launch {
            var lastLens = database.getEffectiveAuthLens()
            database.authLensFlow.collect { newLens ->
                if (newLens != lastLens) {
                    lastLens = newLens
                    startSubscription(newLens)
                }
            }
        }

        awaitClose {
            lensMonitorJob.cancel()
            activeJob?.cancel()
        }
    }

    internal fun childEventsFlow(): Flow<ChildEvent> = callbackFlow {
        var previousChildren: Map<String, DataSnapshot>? = null

        val job = launch {
            try {
                snapshotsFlow().collect { snapshot ->
                    val currentList = snapshot.children.toList()
                    val events = diffChildSnapshots(previousChildren, currentList, querySpec)
                    for (event in events) {
                        trySend(event)
                    }
                    previousChildren = currentList.associateBy { it.key ?: "" }
                }
            } catch (e: Exception) {
                if (e !is CancellationException) {
                    close(e)
                }
            }
        }

        awaitClose {
            job.cancel()
        }
    }
}
