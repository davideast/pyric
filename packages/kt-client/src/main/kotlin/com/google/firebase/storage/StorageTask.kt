package com.google.firebase.storage

import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.Executor

/**
 * Controllable asynchronous Storage operation base class, matching upstream
 * Android `com.google.firebase.storage.StorageTask`.
 */
abstract class StorageTask<TResult : StorageTask.ProvideError> internal constructor(
    internal val targetReference: StorageReference
) : ControllableTask<TResult>() {

    interface ProvideError {
        val error: Exception?
    }

    open inner class SnapshotBase(
        override val error: Exception?
    ) : ProvideError {
        val task: StorageTask<TResult>
            get() = this@StorageTask

        val storage: StorageReference
            get() = targetReference
    }

    protected val stateLock = Any()
    private val listeners = StorageTaskListeners<TResult>(stateLock)

    private var internalState: StorageTaskInternalState = StorageTaskInternalState.IN_PROGRESS
    private var terminalResult: TResult? = null
    private var terminalException: Exception? = null
    private var resumeGate: CompletableDeferred<Unit>? = null
    private var settlingThread: Thread? = null
    private val deferredPreCompleteReplays = ArrayList<() -> Unit>()
    private val deferredCompleteReplays = ArrayList<() -> Unit>()

    abstract val snapshot: TResult

    override fun isComplete(): Boolean =
        synchronized(stateLock) {
            internalState.isTerminal &&
                (settlingThread == null || settlingThread === Thread.currentThread())
        }

    override fun isSuccessful(): Boolean =
        synchronized(stateLock) { internalState == StorageTaskInternalState.SUCCESS }

    override fun isCanceled(): Boolean =
        synchronized(stateLock) {
            internalState == StorageTaskInternalState.CANCELING ||
                internalState == StorageTaskInternalState.CANCELED
        }

    override fun isInProgress(): Boolean =
        synchronized(stateLock) { internalState.isActiveTransfer }

    override fun isPaused(): Boolean =
        synchronized(stateLock) { internalState == StorageTaskInternalState.PAUSED }

    @Suppress("UNCHECKED_CAST")
    override fun getResult(): TResult = synchronized(stateLock) {
        if (internalState == StorageTaskInternalState.CANCELED ||
            internalState == StorageTaskInternalState.CANCELING
        ) {
            throw java.util.concurrent.CancellationException("Task is already canceled")
        }
        if (internalState == StorageTaskInternalState.SUCCESS) {
            return terminalResult as TResult
        }
        throw terminalException ?: IllegalStateException("Task is not yet complete")
    }

    @Suppress("UNCHECKED_CAST")
    override fun <X : Throwable> getResult(exceptionType: Class<X>): TResult = synchronized(stateLock) {
        if (internalState == StorageTaskInternalState.CANCELED ||
            internalState == StorageTaskInternalState.CANCELING
        ) {
            throw java.util.concurrent.CancellationException("Task is already canceled")
        }
        if (internalState == StorageTaskInternalState.SUCCESS) {
            return terminalResult as TResult
        }
        val ex = terminalException
        if (exceptionType.isInstance(ex)) {
            throw exceptionType.cast(ex)
        }
        throw ex ?: IllegalStateException("Task is not yet complete")
    }

    override fun getException(): Exception? =
        synchronized(stateLock) { terminalException }

    override fun pause(): Boolean {
        val dispatchPaused: () -> Unit
        synchronized(stateLock) {
            if (internalState != StorageTaskInternalState.IN_PROGRESS) {
                return false
            }
            internalState = StorageTaskInternalState.PAUSED
            if (resumeGate == null) {
                resumeGate = CompletableDeferred()
            }
            onPausedTransitionLocked()
            dispatchPaused = listeners.preparePausedDispatchLocked(snapshot)
        }
        dispatchPaused()
        return true
    }

    override fun resume(): Boolean {
        val gateToRelease: CompletableDeferred<Unit>?
        synchronized(stateLock) {
            if (internalState != StorageTaskInternalState.PAUSED) {
                return false
            }
            internalState = StorageTaskInternalState.IN_PROGRESS
            gateToRelease = resumeGate
            resumeGate = null
            onResumedTransitionLocked()
        }
        gateToRelease?.complete(Unit)
        onResumedPostUnlock()
        return true
    }

    override fun cancel(): Boolean {
        val cancelError = StorageException(StorageException.ERROR_CANCELED)
        val gateToCancel: CompletableDeferred<Unit>?
        val backgroundRollback: (() -> Unit)?
        val dispatches: Pair<() -> Unit, () -> Unit>
        synchronized(stateLock) {
            if (internalState.isTerminal || internalState == StorageTaskInternalState.CANCELING) {
                return false
            }
            gateToCancel = resumeGate
            resumeGate = null
            terminalException = cancelError
            onCanceledTransitionLocked(cancelError)
            backgroundRollback = tryDeferCancelForRollbackLocked(cancelError)
            internalState = StorageTaskInternalState.CANCELED
            settlingThread = Thread.currentThread()
            dispatches = listeners.prepareTerminalFailureDispatchLocked(
                task = this,
                error = cancelError,
                canceled = true
            )
        }
        gateToCancel?.completeExceptionally(CancellationException("StorageTask canceled"))
        if (backgroundRollback != null) {
            backgroundRollback.invoke()
        } else {
            onCanceledCleanup()
        }
        runTwoPhaseTerminalDispatch(dispatches)
        return true
    }

    protected suspend fun awaitActiveOrThrowCanceled() {
        while (true) {
            val gate: CompletableDeferred<Unit>?
            synchronized(stateLock) {
                if (internalState == StorageTaskInternalState.CANCELING ||
                    internalState == StorageTaskInternalState.CANCELED ||
                    internalState.isTerminal
                ) {
                    throw CancellationException("StorageTask is no longer active")
                }
                gate = if (internalState == StorageTaskInternalState.PAUSED) resumeGate else null
            }
            if (gate == null) {
                return
            }
            gate.await()
        }
    }

    internal fun currentInternalState(): StorageTaskInternalState =
        synchronized(stateLock) { internalState }

    protected fun notifyProgressIfActive(progressSnapshot: TResult) {
        val dispatchProgress = synchronized(stateLock) {
            if (internalState == StorageTaskInternalState.IN_PROGRESS) {
                listeners.prepareProgressDispatchLocked(progressSnapshot)
            } else {
                null
            }
        }
        dispatchProgress?.invoke()
    }

    protected fun tryCompleteSuccess(finalSnapshot: TResult): Boolean {
        val dispatches = synchronized(stateLock) {
            if (internalState != StorageTaskInternalState.IN_PROGRESS) {
                null
            } else {
                internalState = StorageTaskInternalState.SUCCESS
                terminalResult = finalSnapshot
                settlingThread = Thread.currentThread()
                onSuccessTransitionLocked(finalSnapshot)
                listeners.prepareTerminalSuccessDispatchLocked(this, finalSnapshot)
            }
        } ?: return false

        runTwoPhaseTerminalDispatch(dispatches)
        return true
    }

    protected fun tryCompleteFailure(error: StorageException): Boolean {
        val gateToFail: CompletableDeferred<Unit>?
        val dispatches: Pair<() -> Unit, () -> Unit>?
        synchronized(stateLock) {
            if (internalState.isTerminal || internalState == StorageTaskInternalState.CANCELING) {
                gateToFail = null
                dispatches = null
            } else {
                internalState = StorageTaskInternalState.FAILURE
                terminalException = error
                settlingThread = Thread.currentThread()
                gateToFail = resumeGate
                resumeGate = null
                onFailureTransitionLocked(error)
                dispatches = listeners.prepareTerminalFailureDispatchLocked(
                    task = this,
                    error = error,
                    canceled = false
                )
            }
        }
        if (dispatches == null) {
            return false
        }
        gateToFail?.completeExceptionally(error)
        runTwoPhaseTerminalDispatch(dispatches)
        return true
    }

    private fun runTwoPhaseTerminalDispatch(dispatches: Pair<() -> Unit, () -> Unit>) {
        onTaskDeactivated()
        dispatches.first()
        // Drain pre-complete replays (progress/paused/success/failure/canceled) while
        // settlingThread is still active so external callers awaiting isComplete/await()
        // never return before callbacks registered prior to completion have finished.
        while (true) {
            val preBatch = synchronized(stateLock) {
                if (deferredPreCompleteReplays.isEmpty()) {
                    settlingThread = null
                    null
                } else {
                    ArrayList(deferredPreCompleteReplays).also { deferredPreCompleteReplays.clear() }
                }
            } ?: break
            for (replay in preBatch) {
                replay()
            }
        }
        dispatches.second()
        val completeBatch = synchronized(stateLock) {
            ArrayList(deferredCompleteReplays).also { deferredCompleteReplays.clear() }
        }
        for (replay in completeBatch) {
            replay()
        }
    }

    private inline fun registerOrReplay(
        isCompleteCallback: Boolean = false,
        crossinline blockLocked: () -> (() -> Unit)?
    ): StorageTask<TResult> {
        val immediate = synchronized(stateLock) {
            val replay = blockLocked()
            if (replay != null && settlingThread != null && settlingThread !== Thread.currentThread()) {
                if (isCompleteCallback) {
                    deferredCompleteReplays.add(replay)
                } else {
                    deferredPreCompleteReplays.add(replay)
                }
                null
            } else {
                replay
            }
        }
        immediate?.invoke()
        return this
    }

    protected open fun onPausedTransitionLocked() {}
    protected open fun onResumedTransitionLocked() {}
    protected open fun onResumedPostUnlock() {}
    protected open fun onCanceledTransitionLocked(cancelError: StorageException) {}
    protected open fun tryDeferCancelForRollbackLocked(cancelError: StorageException): (() -> Unit)? = null
    protected open fun onCanceledCleanup() {}
    protected open fun onSuccessTransitionLocked(finalSnapshot: TResult) {}
    protected open fun onFailureTransitionLocked(error: StorageException) {}
    protected open fun onTaskDeactivated() {}

    override fun addOnProgressListener(listener: OnProgressListener<in TResult>): StorageTask<TResult> =
        registerOrReplay { listeners.addProgressLocked(listener, null, internalState, snapshot) }

    override fun addOnProgressListener(
        executor: Executor,
        listener: OnProgressListener<in TResult>
    ): StorageTask<TResult> =
        registerOrReplay { listeners.addProgressLocked(listener, executor, internalState, snapshot) }

    fun removeOnProgressListener(listener: OnProgressListener<in TResult>): StorageTask<TResult> {
        listeners.removeProgress(listener)
        return this
    }

    override fun addOnPausedListener(listener: OnPausedListener<in TResult>): StorageTask<TResult> =
        registerOrReplay { listeners.addPausedLocked(listener, null, internalState, snapshot) }

    override fun addOnPausedListener(
        executor: Executor,
        listener: OnPausedListener<in TResult>
    ): StorageTask<TResult> =
        registerOrReplay { listeners.addPausedLocked(listener, executor, internalState, snapshot) }

    fun removeOnPausedListener(listener: OnPausedListener<in TResult>): StorageTask<TResult> {
        listeners.removePaused(listener)
        return this
    }

    override fun addOnSuccessListener(listener: OnSuccessListener<in TResult>): StorageTask<TResult> =
        registerOrReplay { listeners.addSuccessLocked(listener, null, internalState, snapshot) }

    override fun addOnSuccessListener(
        executor: Executor,
        listener: OnSuccessListener<in TResult>
    ): StorageTask<TResult> =
        registerOrReplay { listeners.addSuccessLocked(listener, executor, internalState, snapshot) }

    fun removeOnSuccessListener(listener: OnSuccessListener<in TResult>): StorageTask<TResult> {
        listeners.removeSuccess(listener)
        return this
    }

    override fun addOnFailureListener(listener: OnFailureListener): StorageTask<TResult> =
        registerOrReplay { listeners.addFailureLocked(listener, null, internalState, terminalException) }

    override fun addOnFailureListener(
        executor: Executor,
        listener: OnFailureListener
    ): StorageTask<TResult> =
        registerOrReplay { listeners.addFailureLocked(listener, executor, internalState, terminalException) }

    fun removeOnFailureListener(listener: OnFailureListener): StorageTask<TResult> {
        listeners.removeFailure(listener)
        return this
    }

    override fun addOnCompleteListener(listener: OnCompleteListener<TResult>): StorageTask<TResult> =
        registerOrReplay(isCompleteCallback = true) { listeners.addCompleteLocked(listener, null, internalState, this) }

    override fun addOnCompleteListener(
        executor: Executor,
        listener: OnCompleteListener<TResult>
    ): StorageTask<TResult> =
        registerOrReplay(isCompleteCallback = true) { listeners.addCompleteLocked(listener, executor, internalState, this) }

    fun removeOnCompleteListener(listener: OnCompleteListener<TResult>): StorageTask<TResult> {
        listeners.removeComplete(listener)
        return this
    }

    override fun addOnCanceledListener(listener: OnCanceledListener): StorageTask<TResult> =
        registerOrReplay { listeners.addCanceledLocked(listener, null, internalState) }

    override fun addOnCanceledListener(
        executor: Executor,
        listener: OnCanceledListener
    ): StorageTask<TResult> =
        registerOrReplay { listeners.addCanceledLocked(listener, executor, internalState) }

    fun removeOnCanceledListener(listener: OnCanceledListener): StorageTask<TResult> {
        listeners.removeCanceled(listener)
        return this
    }
}
