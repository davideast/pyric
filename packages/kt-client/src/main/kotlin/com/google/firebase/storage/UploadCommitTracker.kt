package com.google.firebase.storage

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Coordinates in-flight upload commits (`storage.finishUpload` / `storage.putBytes`)
 * with `pause()`, `resume()`, and `cancel()` rollback guarantees.
 */
internal class UploadCommitTracker(
    private val lock: Any,
    private val reference: StorageReference,
    private val scope: CoroutineScope
) {
    private var inFlightCommit: CompletableDeferred<Result<CommittedUploadReceipt>>? = null
    private var heldPausedOutcome: Result<CommittedUploadReceipt>? = null

    suspend fun runCommit(
        onClearStagedIdLocked: () -> Unit,
        commitCall: suspend () -> CommittedUploadReceipt
    ): Result<CommittedUploadReceipt> {
        val deferred = CompletableDeferred<Result<CommittedUploadReceipt>>()
        synchronized(lock) {
            inFlightCommit = deferred
        }
        val outcome = try {
            Result.success(commitCall())
        } catch (t: Throwable) {
            Result.failure(StorageException.fromWireException(t))
        }
        synchronized(lock) {
            onClearStagedIdLocked()
            if (outcome.isFailure && inFlightCommit === deferred) {
                inFlightCommit = null
            }
        }
        deferred.complete(outcome)
        return outcome
    }

    fun clearInFlight() {
        synchronized(lock) {
            inFlightCommit = null
        }
    }

    fun holdIfPausedLocked(
        currentState: StorageTaskInternalState,
        outcome: Result<CommittedUploadReceipt>
    ): Boolean {
        inFlightCommit = null
        if (currentState == StorageTaskInternalState.PAUSED) {
            heldPausedOutcome = outcome
            return true
        }
        return false
    }

    fun takeHeldPausedOutcome(): Result<CommittedUploadReceipt>? =
        synchronized(lock) {
            val held = heldPausedOutcome
            heldPausedOutcome = null
            held
        }

    fun prepareDeferredCancelRollbackLocked(
        stagedUploadIdToAbort: String?
    ): (() -> Unit)? {
        val held = heldPausedOutcome
        heldPausedOutcome = null
        val pending = inFlightCommit
        inFlightCommit = null
        if (held == null && pending == null) {
            return null
        }
        return {
            scope.launch {
                try {
                    val resolved = held ?: pending?.await()
                    val receipt = resolved?.getOrNull()
                    if (receipt != null) {
                        ChunkedUploadDriver.rollbackCommittedUpload(reference, receipt)
                    } else if (stagedUploadIdToAbort != null) {
                        ChunkedUploadDriver.abortSession(reference, stagedUploadIdToAbort)
                    }
                } catch (_: Throwable) {
                    // Best-effort post-cancel rollback on background scope.
                }
            }
        }
    }
}
