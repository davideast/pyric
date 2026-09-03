package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class BridgeOperationDispatcher(
    private val scope: CoroutineScope,
    private val defaultTimeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS
) {
    private val opCounter = AtomicLong(0)
    private val pendingOps = ConcurrentHashMap<String, PendingOp>()

    private data class PendingOp(
        val method: String,
        val deferred: CompletableDeferred<Any?>,
        val timeoutJob: Job
    )

    suspend fun executeOp(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Any? {
        val id = "rop-${opCounter.incrementAndGet()}"
        val deferred = CompletableDeferred<Any?>()
        val effectiveTimeout = timeoutMs ?: defaultTimeoutMs

        val timeoutJob = scope.launch {
            delay(effectiveTimeout)
            if (pendingOps.remove(id) != null) {
                deferred.completeExceptionally(
                    FirebaseFirestoreException(
                        "Remote sandbox op timed out after ${effectiveTimeout}ms (op: $method). Is pyric sandbox still running?",
                        FirebaseFirestoreException.Code.DEADLINE_EXCEEDED
                    )
                )
            }
        }

        pendingOps[id] = PendingOp(method, deferred, timeoutJob)

        val opPayload = mutableMapOf<String, Any?>("method" to method)
        opPayload.putAll(params)
        if (actAs != null) {
            opPayload["actAs"] = actAs
        }

        val frame = BridgeProtocol.createWorkerOpFrame(id, opPayload)
        try {
            sendJson(jsonSerializer(frame))
        } catch (e: Throwable) {
            timeoutJob.cancel()
            pendingOps.remove(id)
            deferred.completeExceptionally(
                FirebaseFirestoreException(
                    "Failed to dispatch op to bridge: ${e.message}",
                    FirebaseFirestoreException.Code.UNAVAILABLE,
                    e
                )
            )
        }

        return deferred.await()
    }

    fun handleWorkerRes(msg: Map<String, Any?>) {
        val id = msg["id"] as? String ?: return
        val pending = pendingOps.remove(id) ?: return
        pending.timeoutJob.cancel()

        val ok = msg["ok"] == true
        if (ok) {
            pending.deferred.complete(msg["value"])
        } else {
            @Suppress("UNCHECKED_CAST")
            val errorMap = msg["error"] as? Map<String, Any?> ?: emptyMap()
            val codeStr = errorMap["code"] as? String ?: "unknown"
            val messageStr = errorMap["message"] as? String ?: "Unknown sandbox error"
            val denialContext = errorMap["denialContext"]

            val firestoreCode = FirebaseFirestoreException.Code.fromWireCode(codeStr)
            val exception = FirebaseFirestoreException(
                messageStr,
                firestoreCode,
                denialContext = denialContext
            )
            pending.deferred.completeExceptionally(exception)
        }
    }

    fun failAll(code: FirebaseFirestoreException.Code, message: String, cause: Throwable? = null) {
        val iterator = pendingOps.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            iterator.remove()
            entry.value.timeoutJob.cancel()
            entry.value.deferred.completeExceptionally(
                FirebaseFirestoreException(message, code, cause)
            )
        }
    }
}
