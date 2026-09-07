package dev.pyric.database

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.auth.AuthLens
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

data class RtdbQuerySpec(
    val orderBy: Map<String, Any?>? = null,
    val bounds: List<Map<String, Any?>> = emptyList(),
    val limit: Map<String, Any?>? = null
) {
    fun isEmpty(): Boolean = orderBy == null && bounds.isEmpty() && limit == null

    fun toMap(): Map<String, Any?> {
        return mapOf(
            "orderBy" to orderBy,
            "bounds" to bounds,
            "limit" to limit
        )
    }
}

interface ValueEventListener {
    fun onDataChange(snapshot: DataSnapshot)
    fun onCancelled(error: DatabaseError)
}

interface ChildEventListener {
    fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?)
    fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?)
    fun onChildRemoved(snapshot: DataSnapshot)
    fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?)
    fun onCancelled(error: DatabaseError)
}

sealed class ChildEvent(val snapshot: DataSnapshot, val previousChildName: String? = null) {
    class Added(snapshot: DataSnapshot, previousChildName: String?) : ChildEvent(snapshot, previousChildName)
    class Changed(snapshot: DataSnapshot, previousChildName: String?) : ChildEvent(snapshot, previousChildName)
    class Removed(snapshot: DataSnapshot) : ChildEvent(snapshot, null)
    class Moved(snapshot: DataSnapshot, previousChildName: String?) : ChildEvent(snapshot, previousChildName)
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
        val clean = childPath.trim('/')
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "child", "path" to clean))
        )
    }

    fun orderByKey(): Query {
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "key"))
        )
    }

    fun orderByValue(): Query {
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "value"))
        )
    }

    fun orderByPriority(): Query {
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(orderBy = mapOf("kind" to "priority"))
        )
    }

    fun equalTo(value: Any?, key: String? = null): Query {
        val bound = mutableMapOf<String, Any?>("kind" to "equalTo", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun startAt(value: Any?, key: String? = null): Query {
        val bound = mutableMapOf<String, Any?>("kind" to "startAt", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun startAfter(value: Any?, key: String? = null): Query {
        val bound = mutableMapOf<String, Any?>("kind" to "startAfter", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun endAt(value: Any?, key: String? = null): Query {
        val bound = mutableMapOf<String, Any?>("kind" to "endAt", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun endBefore(value: Any?, key: String? = null): Query {
        val bound = mutableMapOf<String, Any?>("kind" to "endBefore", "value" to value)
        if (key != null) bound["key"] = key
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(bounds = querySpec.bounds + bound)
        )
    }

    fun limitToFirst(limit: Int): Query {
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(limit = mapOf("kind" to "limitToFirst", "n" to limit))
        )
    }

    fun limitToLast(limit: Int): Query {
        return Query(
            database = database,
            path = path,
            querySpec = querySpec.copy(limit = mapOf("kind" to "limitToLast", "n" to limit))
        )
    }

    fun get(): Task<DataSnapshot> {
        val tcs = TaskCompletionSource<DataSnapshot>()
        queryScope.launch {
            try {
                val params = mutableMapOf<String, Any?>("path" to path)
                if (!querySpec.isEmpty()) {
                    params["query"] = querySpec.toMap()
                }
                val res = database.bridgeClient.op(
                    method = "rtdb.get",
                    params = params,
                    actAs = database.getEffectiveAuthLens().toMap()
                )
                @Suppress("UNCHECKED_CAST")
                val wire = res as? Map<String, Any?>
                tcs.setResult(DataSnapshot.fromWire(ref, wire))
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun addValueEventListener(listener: ValueEventListener): ValueEventListener {
        val job = queryScope.launch {
            try {
                snapshots().collect { snap ->
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
                val snap = snapshots().first()
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
                childEvents().collect { event ->
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
}

fun Query.snapshots(): Flow<DataSnapshot> = callbackFlow {
    val target = mutableMapOf<String, Any?>(
        "service" to "rtdb",
        "path" to path
    )
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

fun Query.childEvents(): Flow<ChildEvent> = callbackFlow {
    var previousChildren: Map<String, DataSnapshot>? = null

    val job = launch {
        try {
            snapshots().collect { snapshot ->
                val currentList = snapshot.children.toList()
                val currentMap = currentList.associateBy { it.key ?: "" }

                val prev = previousChildren
                if (prev == null) {
                    var prevKey: String? = null
                    for (child in currentList) {
                        trySend(ChildEvent.Added(child, prevKey))
                        prevKey = child.key
                    }
                } else {
                    for ((k, oldSnap) in prev) {
                        if (!currentMap.containsKey(k)) {
                            trySend(ChildEvent.Removed(oldSnap))
                        }
                    }
                    var prevKey: String? = null
                    for (child in currentList) {
                        val k = child.key ?: ""
                        val oldSnap = prev[k]
                        if (oldSnap == null) {
                            trySend(ChildEvent.Added(child, prevKey))
                        } else if (oldSnap.value != child.value || oldSnap.priority != child.priority) {
                            trySend(ChildEvent.Changed(child, prevKey))
                        }
                        prevKey = k
                    }
                }
                previousChildren = currentMap
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
