package com.google.firebase.database

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.database.internal.isInfoPath
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
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
    private val valueListeners = ConcurrentHashMap<ValueEventListener, RtdbSnapshotRegistration>()
    private val childListeners = ConcurrentHashMap<ChildEventListener, RtdbSnapshotRegistration>()

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
            val rawTcs = TaskCompletionSource<Any?>()
            rawTcs.task.addOnSuccessListener { raw ->
                tcs.trySetResult(DataSnapshot(ref, raw))
            }.addOnFailureListener { err ->
                tcs.trySetException(DatabaseError.wrapTaskException(err))
            }
            database.infoHub.readValue(path, rawTcs)
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
        val registration = RtdbSnapshotRegistration(
            query = this,
            scope = queryScope,
            singleEvent = false,
            onSnapshot = { snap -> listener.onDataChange(snap) },
            onError = { err -> listener.onCancelled(DatabaseError.fromException(err)) }
        )
        valueListeners.put(listener, registration)?.cancel()
        return listener
    }

    fun addListenerForSingleValueEvent(listener: ValueEventListener) {
        RtdbSnapshotRegistration(
            query = this,
            scope = queryScope,
            singleEvent = true,
            onSnapshot = { snap -> listener.onDataChange(snap) },
            onError = { err -> listener.onCancelled(DatabaseError.fromException(err)) }
        )
    }

    fun addChildEventListener(listener: ChildEventListener): ChildEventListener {
        val registration = RtdbSnapshotRegistration.registerChildListener(this, queryScope, listener)
        childListeners.put(listener, registration)?.cancel()
        return listener
    }

    fun removeEventListener(listener: ValueEventListener) {
        valueListeners.remove(listener)?.cancel()
    }

    fun removeEventListener(listener: ChildEventListener) {
        childListeners.remove(listener)?.cancel()
    }

    /** Paths under `/.info` are served by the client; every other path is a host subscription. */
    internal fun snapshotsFlow(): Flow<DataSnapshot> =
        RtdbSnapshotRegistration.snapshotsFlow(this, queryScope)

    internal fun childEventsFlow(): Flow<ChildEvent> =
        RtdbSnapshotRegistration.childEventsFlow(this, queryScope)
}
