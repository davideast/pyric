package dev.pyric.database

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import dev.pyric.database.internal.PushIdGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class DatabaseReference(
    database: FirebaseDatabase,
    path: String
) : Query(database, path) {
    private val refScope = CoroutineScope(Dispatchers.IO)

    val key: String?
        get() {
            val trimmed = path.trim('/')
            if (trimmed.isEmpty()) return null
            return trimmed.substringAfterLast('/')
        }

    val parent: DatabaseReference?
        get() {
            val trimmed = path.trim('/')
            if (trimmed.isEmpty()) return null
            val lastSlash = trimmed.lastIndexOf('/')
            val parentPath = if (lastSlash == -1) "" else trimmed.substring(0, lastSlash)
            return DatabaseReference(database, parentPath)
        }

    val root: DatabaseReference
        get() = DatabaseReference(database, "")

    fun child(pathString: String): DatabaseReference {
        val cleanChild = pathString.trim('/')
        if (cleanChild.isEmpty()) return this
        val combined = if (path.isEmpty()) cleanChild else "$path/$cleanChild"
        return DatabaseReference(database, combined)
    }

    fun push(): DatabaseReference {
        val pushKey = PushIdGenerator.generatePushId()
        return child(pushKey)
    }

    fun setValue(value: Any?): Task<Void?> = executeOp(
        method = "rtdb.set",
        params = mapOf("path" to path, "value" to value)
    )

    fun setValue(value: Any?, priority: Any?): Task<Void?> = executeOp(
        method = "rtdb.setWithPriority",
        params = mapOf("path" to path, "value" to value, "priority" to priority)
    )

    fun setPriority(priority: Any?): Task<Void?> = executeOp(
        method = "rtdb.setPriority",
        params = mapOf("path" to path, "priority" to priority)
    )

    fun updateChildren(update: Map<String, Any?>): Task<Void?> = executeOp(
        method = "rtdb.update",
        params = mapOf("path" to path, "values" to update)
    )

    fun removeValue(): Task<Void?> = executeOp(
        method = "rtdb.remove",
        params = mapOf("path" to path)
    )

    fun onDisconnect(): OnDisconnect = OnDisconnect(this)

    fun runTransaction(handler: Transaction.Handler, fireLocalEvents: Boolean = true) {
        refScope.launch {
            try {
                var maxRetries = 25
                while (maxRetries-- > 0) {
                    val currentWire = database.bridgeClient.op(
                        method = "rtdb.get",
                        params = mapOf("path" to path),
                        actAs = database.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val snapMap = currentWire as? Map<String, Any?>
                    val currentVal = snapMap?.get("value")
                    val currentPriority = snapMap?.get("priority")

                    val mutableData = MutableData(currentVal, currentPriority, key)
                    val result = handler.doTransaction(mutableData)

                    if (!result.isSuccess) {
                        val currentSnap = DataSnapshot.fromWire(this@DatabaseReference, snapMap)
                        handler.onComplete(null, false, currentSnap)
                        return@launch
                    }

                    val commitRes = database.bridgeClient.op(
                        method = "rtdb.transactionCommit",
                        params = mapOf(
                            "path" to path,
                            "expected" to currentVal,
                            "value" to result.mutableData?.value,
                            "applyLocally" to fireLocalEvents
                        ),
                        actAs = database.getEffectiveAuthLens().toMap()
                    )
                    @Suppress("UNCHECKED_CAST")
                    val commitMap = commitRes as? Map<String, Any?>
                    val retry = commitMap?.get("retry") == true
                    if (!retry) {
                        @Suppress("UNCHECKED_CAST")
                        val finalSnapMap = commitMap?.get("snapshot") as? Map<String, Any?>
                        val finalSnap = DataSnapshot.fromWire(this@DatabaseReference, finalSnapMap)
                        handler.onComplete(null, commitMap?.get("committed") == true, finalSnap)
                        return@launch
                    }
                }
                handler.onComplete(
                    DatabaseError(DatabaseError.OPERATION_FAILED, "Transaction exceeded max retries"),
                    false,
                    null
                )
            } catch (e: Exception) {
                handler.onComplete(DatabaseError.fromException(e), false, null)
            }
        }
    }

    private fun executeOp(method: String, params: Map<String, Any?>): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        refScope.launch {
            try {
                database.bridgeClient.op(
                    method = method,
                    params = params,
                    actAs = database.getEffectiveAuthLens().toMap()
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    override fun toString(): String {
        val cleanUrl = database.url.trimEnd('/')
        return if (path.isEmpty()) cleanUrl else "$cleanUrl/$path"
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DatabaseReference) return false
        return database.url == other.database.url && path == other.path
    }

    override fun hashCode(): Int {
        return 31 * database.url.hashCode() + path.hashCode()
    }
}
