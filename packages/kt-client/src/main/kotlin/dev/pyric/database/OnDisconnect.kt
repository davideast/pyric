package dev.pyric.database

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class OnDisconnect(private val ref: DatabaseReference) {
    private val scope = CoroutineScope(Dispatchers.IO)

    fun setValue(value: Any?): Task<Void?> = executeOp(
        method = "rtdb.onDisconnectSet",
        params = mapOf("path" to ref.path, "value" to value)
    )

    fun setValue(value: Any?, priority: Any?): Task<Void?> = executeOp(
        method = "rtdb.onDisconnectSet",
        params = mapOf("path" to ref.path, "value" to value, "priority" to priority)
    )

    fun updateChildren(update: Map<String, Any?>): Task<Void?> = executeOp(
        method = "rtdb.onDisconnectUpdate",
        params = mapOf("path" to ref.path, "values" to update)
    )

    fun removeValue(): Task<Void?> = executeOp(
        method = "rtdb.onDisconnectRemove",
        params = mapOf("path" to ref.path)
    )

    fun cancel(): Task<Void?> = executeOp(
        method = "rtdb.onDisconnectCancel",
        params = mapOf("path" to ref.path)
    )

    private fun executeOp(method: String, params: Map<String, Any?>): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        scope.launch {
            try {
                ref.database.bridgeClient.op(
                    method = method,
                    params = params,
                    actAs = ref.database.getEffectiveAuthLens().toMap()
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }
}
