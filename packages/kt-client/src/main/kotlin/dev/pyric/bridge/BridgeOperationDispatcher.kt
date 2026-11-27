package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The transport did not take the frame: there was no transport, or its `send`
 * returned false. The frame never left the device (ADR-0019, amendment 2026-10-17).
 */
internal class TransportRefused(message: String) :
    FirebaseFirestoreException(message, FirebaseFirestoreException.Code.UNAVAILABLE)

internal data class BridgeSequencedResult(
    val value: Any?,
    val wireSeq: Long
)

/** What happened to an operation's frame when it was handed to the transport. */
internal sealed interface BridgeDispatch {
    /** The transport took the frame, or the operation already failed. */
    class Started(val result: CompletableDeferred<BridgeSequencedResult>) : BridgeDispatch

    /** The transport refused the frame. The operation is not registered and may be sent again. */
    data object Refused : BridgeDispatch
}

class BridgeOperationDispatcher(
    private val scope: CoroutineScope,
    private val defaultTimeoutMs: Long = BridgeProtocol.DEFAULT_OP_TIMEOUT_MS,
    private val onDenial: ((FirebaseFirestoreException) -> Unit)? = null
) {
    private val opCounter = AtomicLong(0)
    private val pendingOps = ConcurrentHashMap<String, PendingOp>()

    /** Whether an operation's frame has been handed to the transport. */
    private sealed interface SendState {
        data object Unsent : SendState
        data object Sent : SendState
        /** The connection dropped before the send returned. */
        class Lost(val error: FirebaseFirestoreException) : SendState
    }

    private class PendingOp(
        val method: String,
        val deferred: CompletableDeferred<BridgeSequencedResult>,
        val timeoutJob: Job
    ) {
        val state = AtomicReference<SendState>(SendState.Unsent)

        /** Moves an unsent operation to lost. False once its frame was handed over. */
        fun markLostIfUnsent(error: FirebaseFirestoreException): Boolean {
            while (true) {
                val current = state.get()
                if (current == SendState.Sent) return false
                if (state.compareAndSet(current, SendState.Lost(error))) return true
            }
        }

        /** Returns the drop's error when the connection dropped before the send returned. */
        fun markSent(): FirebaseFirestoreException? {
            if (state.compareAndSet(SendState.Unsent, SendState.Sent)) return null
            return (state.get() as? SendState.Lost)?.error
        }
    }

    suspend fun executeOp(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): Any? = startSequencedOp(method, params, actAs, timeoutMs, sendJson, jsonSerializer).await().value

    /**
     * Registers the operation and hands its frame to [sendJson] before returning.
     * The result settles on its `worker-res`, its timeout, or a [failAll]. A
     * refused frame fails the operation.
     */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    fun startOp(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): CompletableDeferred<Any?> {
        val sequenced = startSequencedOp(method, params, actAs, timeoutMs, sendJson, jsonSerializer)
        val plain = CompletableDeferred<Any?>()
        sequenced.invokeOnCompletion { cause ->
            if (cause != null) {
                plain.completeExceptionally(cause)
            } else {
                plain.complete(sequenced.getCompleted().value)
            }
        }
        return plain
    }

    internal fun startSequencedOp(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>? = null,
        timeoutMs: Long? = null,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): CompletableDeferred<BridgeSequencedResult> {
        val started = dispatch(method, params, actAs, timeoutMs, holdsRefusal = false, sendJson, jsonSerializer)
        return (started as BridgeDispatch.Started).result
    }

    /**
     * Like [startOp], but with [holdsRefusal] a refused frame returns
     * [BridgeDispatch.Refused] instead of failing, so the caller can hold it.
     */
    internal fun dispatch(
        method: String,
        params: Map<String, Any?>,
        actAs: Map<String, Any?>?,
        timeoutMs: Long?,
        holdsRefusal: Boolean,
        sendJson: (String) -> Unit,
        jsonSerializer: (Any?) -> String
    ): BridgeDispatch {
        val id = "rop-${opCounter.incrementAndGet()}"
        val deferred = CompletableDeferred<BridgeSequencedResult>()
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

        val pending = PendingOp(method, deferred, timeoutJob)
        pendingOps[id] = pending

        val opPayload = mutableMapOf<String, Any?>("method" to method)
        opPayload.putAll(params)
        if (actAs != null) {
            opPayload["actAs"] = actAs
        }

        val frame = BridgeProtocol.createWorkerOpFrame(id, opPayload)
        try {
            sendJson(jsonSerializer(frame))
        } catch (refused: TransportRefused) {
            return settleRefused(id, pending, holdsRefusal, refused)
        } catch (e: Throwable) {
            failDispatch(id, pending, e)
            return BridgeDispatch.Started(deferred)
        }
        // A frame enqueued after the drop went to a socket that is gone.
        val lost = pending.markSent()
        if (lost != null) fail(id, pending, lost)
        return BridgeDispatch.Started(deferred)
    }

    private fun settleRefused(
        id: String,
        pending: PendingOp,
        holdsRefusal: Boolean,
        refused: TransportRefused
    ): BridgeDispatch {
        // A response, the timeout or a final failAll already settled it.
        val settledElsewhere = !pendingOps.remove(id, pending)
        if (settledElsewhere || !holdsRefusal) {
            pending.timeoutJob.cancel()
            pending.deferred.completeExceptionally(dispatchFailure(refused))
            return BridgeDispatch.Started(pending.deferred)
        }
        // A held operation gets a new timeout when it is sent.
        pending.timeoutJob.cancel()
        return BridgeDispatch.Refused
    }

    private fun failDispatch(id: String, pending: PendingOp, e: Throwable) {
        pending.timeoutJob.cancel()
        pendingOps.remove(id, pending)
        pending.deferred.completeExceptionally(dispatchFailure(e))
    }

    private fun dispatchFailure(e: Throwable) = FirebaseFirestoreException(
        "Failed to dispatch op to bridge: ${e.message}",
        FirebaseFirestoreException.Code.UNAVAILABLE,
        e
    )

    private fun fail(id: String, pending: PendingOp, error: FirebaseFirestoreException) {
        if (!pendingOps.remove(id, pending)) return
        pending.timeoutJob.cancel()
        pending.deferred.completeExceptionally(error)
    }

    fun handleWorkerRes(msg: Map<String, Any?>, wireSeq: Long = 0L) {
        val id = msg["id"] as? String ?: return
        val pending = pendingOps.remove(id) ?: return
        pending.timeoutJob.cancel()

        val ok = msg["ok"] == true
        if (ok) {
            pending.deferred.complete(BridgeSequencedResult(msg["value"], wireSeq))
        } else {
            @Suppress("UNCHECKED_CAST")
            val errorMap = msg["error"] as? Map<String, Any?> ?: emptyMap()
            val codeStr = errorMap["code"] as? String ?: "unknown"
            val messageStr = errorMap["message"] as? String ?: "Unknown sandbox error"
            val denialContext = mergeDenialExtras(errorMap)
            @Suppress("UNCHECKED_CAST")
            val aiEnvelope = (errorMap["aiEnvelope"] ?: errorMap["envelope"]) as? Map<String, Any?>

            val firestoreCode = FirebaseFirestoreException.Code.fromWireCode(codeStr)
            val exception = FirebaseFirestoreException(
                messageStr,
                firestoreCode,
                denialContext = denialContext,
                wireCode = codeStr,
                aiEnvelope = aiEnvelope
            )
            val isStorageDenial =
                codeStr.equals("storage/unauthorized", ignoreCase = true) ||
                    codeStr.equals("unauthorized", ignoreCase = true)
            if (denialContext != null ||
                firestoreCode == FirebaseFirestoreException.Code.PERMISSION_DENIED ||
                isStorageDenial
            ) {
                onDenial?.invoke(exception)
            }
            pending.deferred.completeExceptionally(exception)
        }
    }

    private fun mergeDenialExtras(errorMap: Map<String, Any?>): Any? =
        mergeBridgeDenialExtras(errorMap)

    /**
     * Fails every operation whose frame was handed to the transport. With
     * [keepUnsent], an operation whose send has not returned is marked lost
     * instead: its sender fails it if the transport took the frame, and may hold
     * it if the transport refused it.
     */
    fun failAll(
        code: FirebaseFirestoreException.Code,
        message: String,
        cause: Throwable? = null,
        keepUnsent: Boolean = false
    ) {
        for ((id, pending) in pendingOps) {
            val error = FirebaseFirestoreException(message, code, cause)
            if (keepUnsent && pending.markLostIfUnsent(error)) continue
            // Its sender then sees it was settled, whatever the transport returns.
            pending.markLostIfUnsent(error)
            fail(id, pending, error)
        }
    }
}

internal fun mergeBridgeDenialExtras(errorMap: Map<String, Any?>): Any? {
    val rawContext = errorMap["denialContext"]
    val topQueryProof = errorMap["queryProof"]
    val topRepro = errorMap["repro"]
    val topRemediation = errorMap["remediation"]
    if (rawContext is Map<*, *>) {
        val needsQueryProof = topQueryProof != null && !rawContext.containsKey("queryProof")
        val needsRepro = topRepro != null && !rawContext.containsKey("repro")
        val needsRemediation = topRemediation != null && !rawContext.containsKey("remediation")
        if (!needsQueryProof && !needsRepro && !needsRemediation) return rawContext
        val merged = LinkedHashMap<Any?, Any?>(rawContext)
        if (needsQueryProof) merged["queryProof"] = topQueryProof
        if (needsRepro) merged["repro"] = topRepro
        if (needsRemediation) merged["remediation"] = topRemediation
        return merged
    }
    return rawContext
}
