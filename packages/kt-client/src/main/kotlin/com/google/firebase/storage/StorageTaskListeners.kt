package com.google.firebase.storage

import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import java.util.concurrent.Executor

internal enum class StorageTaskInternalState {
    NEW,
    IN_PROGRESS,
    PAUSING,
    PAUSED,
    CANCELING,
    CANCELED,
    SUCCESS,
    FAILURE;

    val isTerminal: Boolean
        get() = this == CANCELED || this == SUCCESS || this == FAILURE

    val isActiveTransfer: Boolean
        get() = this == NEW || this == IN_PROGRESS || this == PAUSING
}

internal class BoundTaskListener<L : Any>(
    val listener: L,
    val executor: Executor?
) {
    fun dispatch(action: (L) -> Unit) {
        val targetExecutor = executor
        if (targetExecutor != null) {
            targetExecutor.execute {
                runSafely { action(listener) }
            }
        } else {
            runSafely { action(listener) }
        }
    }

    private inline fun runSafely(block: () -> Unit) {
        try {
            block()
        } catch (_: Throwable) {
            // Listener exceptions must not corrupt StorageTask state transitions.
        }
    }
}

/**
 * Listener registry guarded by the owning [StorageTask]'s `stateLock` so state transitions
 * and listener registration/draining are atomic without holding locks during callbacks.
 */
internal class StorageTaskListeners<T : StorageTask.ProvideError>(
    private val stateLock: Any
) {
    private val progressListeners = ArrayList<BoundTaskListener<OnProgressListener<in T>>>()
    private val pausedListeners = ArrayList<BoundTaskListener<OnPausedListener<in T>>>()
    private val successListeners = ArrayList<BoundTaskListener<OnSuccessListener<in T>>>()
    private val failureListeners = ArrayList<BoundTaskListener<OnFailureListener>>()
    private val completeListeners = ArrayList<BoundTaskListener<OnCompleteListener<T>>>()
    private val canceledListeners = ArrayList<BoundTaskListener<OnCanceledListener>>()

    fun addProgressLocked(
        listener: OnProgressListener<in T>,
        executor: Executor?,
        state: StorageTaskInternalState,
        snapshot: T
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            progressListeners.add(bound)
        }
        return if (state == StorageTaskInternalState.IN_PROGRESS ||
            state == StorageTaskInternalState.SUCCESS
        ) {
            { bound.dispatch { it.onProgress(snapshot) } }
        } else {
            null
        }
    }

    fun removeProgress(listener: OnProgressListener<in T>) {
        synchronized(stateLock) {
            progressListeners.removeAll { it.listener == listener }
        }
    }

    fun addPausedLocked(
        listener: OnPausedListener<in T>,
        executor: Executor?,
        state: StorageTaskInternalState,
        snapshot: T
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            pausedListeners.add(bound)
        }
        return if (state == StorageTaskInternalState.PAUSED) {
            { bound.dispatch { it.onPaused(snapshot) } }
        } else {
            null
        }
    }

    fun removePaused(listener: OnPausedListener<in T>) {
        synchronized(stateLock) {
            pausedListeners.removeAll { it.listener == listener }
        }
    }

    fun addSuccessLocked(
        listener: OnSuccessListener<in T>,
        executor: Executor?,
        state: StorageTaskInternalState,
        snapshot: T
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            successListeners.add(bound)
            return null
        }
        return if (state == StorageTaskInternalState.SUCCESS) {
            { bound.dispatch { it.onSuccess(snapshot) } }
        } else {
            null
        }
    }

    fun removeSuccess(listener: OnSuccessListener<in T>) {
        synchronized(stateLock) {
            successListeners.removeAll { it.listener == listener }
        }
    }

    fun addFailureLocked(
        listener: OnFailureListener,
        executor: Executor?,
        state: StorageTaskInternalState,
        error: Exception?
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            failureListeners.add(bound)
            return null
        }
        return if ((state == StorageTaskInternalState.FAILURE ||
                state == StorageTaskInternalState.CANCELED) && error != null
        ) {
            { bound.dispatch { it.onFailure(error) } }
        } else {
            null
        }
    }

    fun removeFailure(listener: OnFailureListener) {
        synchronized(stateLock) {
            failureListeners.removeAll { it.listener == listener }
        }
    }

    fun addCompleteLocked(
        listener: OnCompleteListener<T>,
        executor: Executor?,
        state: StorageTaskInternalState,
        task: StorageTask<T>
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            completeListeners.add(bound)
            return null
        }
        return { bound.dispatch { it.onComplete(task) } }
    }

    fun removeComplete(listener: OnCompleteListener<T>) {
        synchronized(stateLock) {
            completeListeners.removeAll { it.listener == listener }
        }
    }

    fun addCanceledLocked(
        listener: OnCanceledListener,
        executor: Executor?,
        state: StorageTaskInternalState
    ): (() -> Unit)? {
        val bound = BoundTaskListener(listener, executor)
        if (!state.isTerminal) {
            canceledListeners.add(bound)
            return null
        }
        return if (state == StorageTaskInternalState.CANCELED) {
            { bound.dispatch { it.onCanceled() } }
        } else {
            null
        }
    }

    fun removeCanceled(listener: OnCanceledListener) {
        synchronized(stateLock) {
            canceledListeners.removeAll { it.listener == listener }
        }
    }

    fun prepareProgressDispatchLocked(snapshot: T): () -> Unit {
        val copy = ArrayList(progressListeners)
        return {
            for (entry in copy) {
                entry.dispatch { it.onProgress(snapshot) }
            }
        }
    }

    fun preparePausedDispatchLocked(snapshot: T): () -> Unit {
        val copy = ArrayList(pausedListeners)
        return {
            for (entry in copy) {
                entry.dispatch { it.onPaused(snapshot) }
            }
        }
    }

    fun prepareTerminalSuccessDispatchLocked(
        task: StorageTask<T>,
        snapshot: T
    ): Pair<() -> Unit, () -> Unit> {
        val progressCopy = ArrayList(progressListeners)
        val successCopy = ArrayList(successListeners)
        val completeCopy = ArrayList(completeListeners)
        clearAllLocked()
        val preComplete = {
            for (entry in progressCopy) {
                entry.dispatch { it.onProgress(snapshot) }
            }
            for (entry in successCopy) {
                entry.dispatch { it.onSuccess(snapshot) }
            }
        }
        val onComplete = {
            for (entry in completeCopy) {
                entry.dispatch { it.onComplete(task) }
            }
        }
        return preComplete to onComplete
    }

    fun prepareTerminalFailureDispatchLocked(
        task: StorageTask<T>,
        error: Exception,
        canceled: Boolean
    ): Pair<() -> Unit, () -> Unit> {
        val canceledCopy = if (canceled) ArrayList(canceledListeners) else emptyList()
        val failureCopy = ArrayList(failureListeners)
        val completeCopy = ArrayList(completeListeners)
        clearAllLocked()
        val preComplete = {
            for (entry in canceledCopy) {
                entry.dispatch { it.onCanceled() }
            }
            for (entry in failureCopy) {
                entry.dispatch { it.onFailure(error) }
            }
        }
        val onComplete = {
            for (entry in completeCopy) {
                entry.dispatch { it.onComplete(task) }
            }
        }
        return preComplete to onComplete
    }

    private fun clearAllLocked() {
        progressListeners.clear()
        pausedListeners.clear()
        successListeners.clear()
        failureListeners.clear()
        completeListeners.clear()
        canceledListeners.clear()
    }
}
