package com.google.firebase.storage

import com.google.android.gms.tasks.OnCanceledListener
import com.google.android.gms.tasks.OnCompleteListener
import com.google.android.gms.tasks.OnFailureListener
import com.google.android.gms.tasks.OnSuccessListener
import com.google.android.gms.tasks.Task
import java.util.concurrent.CancellationException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor

fun interface OnProgressListener<TProgress> {
    fun onProgress(snapshot: TProgress)
}

fun interface OnPausedListener<TProgress> {
    fun onPaused(snapshot: TProgress)
}

sealed class TaskState<out T> {
    class InProgress<T>(val snapshot: T) : TaskState<T>()
    class Paused<T>(val snapshot: T) : TaskState<T>()
}

abstract class CancellableTask<StateT> : Task<StateT>() {
    abstract fun cancel(): Boolean
    abstract fun isInProgress(): Boolean

    @get:JvmName("inProgressProp")
    val isInProgress: Boolean
        get() = isInProgress()

    abstract fun addOnProgressListener(listener: OnProgressListener<in StateT>): CancellableTask<StateT>
    abstract fun addOnProgressListener(
        executor: Executor,
        listener: OnProgressListener<in StateT>
    ): CancellableTask<StateT>
}

abstract class ControllableTask<StateT> : CancellableTask<StateT>() {
    abstract fun pause(): Boolean
    abstract fun resume(): Boolean
    abstract fun isPaused(): Boolean

    @get:JvmName("pausedProp")
    val isPaused: Boolean
        get() = isPaused()

    abstract fun addOnPausedListener(listener: OnPausedListener<in StateT>): ControllableTask<StateT>
    abstract fun addOnPausedListener(
        executor: Executor,
        listener: OnPausedListener<in StateT>
    ): ControllableTask<StateT>
}

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

    private val stateLock = Any()
    private var completeState: Boolean = false
    private var successfulState: Boolean = false
    private var canceledState: Boolean = false
    private var pausedState: Boolean = false
    private var inProgressState: Boolean = true
    private var resultValue: TResult? = null
    private var exceptionValue: Exception? = null

    private val terminalCallbacks = mutableListOf<(StorageTask<TResult>) -> Unit>()
    protected val progressListeners = CopyOnWriteArrayList<Pair<Executor?, OnProgressListener<in TResult>>>()
    protected val pausedListeners = CopyOnWriteArrayList<Pair<Executor?, OnPausedListener<in TResult>>>()

    abstract val snapshot: TResult

    override fun isPaused(): Boolean = synchronized(stateLock) { pausedState }

    override fun isInProgress(): Boolean = synchronized(stateLock) { inProgressState && !completeState }

    override fun isComplete(): Boolean = synchronized(stateLock) { completeState }

    override fun isSuccessful(): Boolean = synchronized(stateLock) { successfulState }

    override fun isCanceled(): Boolean = synchronized(stateLock) { canceledState }

    override fun getException(): Exception? = synchronized(stateLock) { exceptionValue }

    @Suppress("UNCHECKED_CAST")
    override fun getResult(): TResult = synchronized(stateLock) {
        if (canceledState) throw CancellationException("Task is already canceled")
        if (successfulState) return resultValue as TResult
        throw exceptionValue ?: IllegalStateException("Task is not yet complete")
    }

    @Suppress("UNCHECKED_CAST")
    override fun <X : Throwable> getResult(exceptionType: Class<X>): TResult = synchronized(stateLock) {
        if (canceledState) throw CancellationException("Task is already canceled")
        if (successfulState) return resultValue as TResult
        if (exceptionType.isInstance(exceptionValue)) throw exceptionType.cast(exceptionValue)
        throw exceptionValue ?: IllegalStateException("Task is not yet complete")
    }

    protected fun setPausedInternal(paused: Boolean) {
        synchronized(stateLock) {
            if (!completeState) {
                pausedState = paused
            }
        }
    }

    protected fun tryCompleteSuccess(result: TResult): Boolean {
        val callbacks = synchronized(stateLock) {
            if (completeState) return false
            completeState = true
            successfulState = true
            inProgressState = false
            pausedState = false
            resultValue = result
            val copy = ArrayList(terminalCallbacks)
            terminalCallbacks.clear()
            copy
        }
        callbacks.forEach { it(this) }
        return true
    }

    protected fun tryCompleteFailure(error: Exception): Boolean {
        val callbacks = synchronized(stateLock) {
            if (completeState) return false
            completeState = true
            successfulState = false
            inProgressState = false
            pausedState = false
            exceptionValue = error
            val copy = ArrayList(terminalCallbacks)
            terminalCallbacks.clear()
            copy
        }
        callbacks.forEach { it(this) }
        return true
    }

    protected fun tryCompleteCanceled(cancelError: StorageException = StorageException(StorageException.ERROR_CANCELED)): Boolean {
        val callbacks = synchronized(stateLock) {
            if (completeState) return false
            completeState = true
            successfulState = false
            canceledState = true
            inProgressState = false
            pausedState = false
            exceptionValue = cancelError
            val copy = ArrayList(terminalCallbacks)
            terminalCallbacks.clear()
            copy
        }
        callbacks.forEach { it(this) }
        return true
    }

    override fun pause(): Boolean = false

    override fun resume(): Boolean = false

    override fun cancel(): Boolean = tryCompleteCanceled(StorageException(StorageException.ERROR_CANCELED))

    override fun addOnProgressListener(listener: OnProgressListener<in TResult>): StorageTask<TResult> {
        progressListeners.add(null to listener)
        if (isSuccessful() || isPaused()) {
            listener.onProgress(snapshot)
        }
        return this
    }

    override fun addOnProgressListener(
        executor: Executor,
        listener: OnProgressListener<in TResult>
    ): StorageTask<TResult> {
        progressListeners.add(executor to listener)
        if (isSuccessful() || isPaused()) {
            val snap = snapshot
            executor.execute { listener.onProgress(snap) }
        }
        return this
    }

    open fun removeOnProgressListener(listener: OnProgressListener<in TResult>): StorageTask<TResult> {
        progressListeners.removeIf { it.second == listener }
        return this
    }

    override fun addOnPausedListener(listener: OnPausedListener<in TResult>): StorageTask<TResult> {
        pausedListeners.add(null to listener)
        if (isPaused()) {
            listener.onPaused(snapshot)
        }
        return this
    }

    override fun addOnPausedListener(
        executor: Executor,
        listener: OnPausedListener<in TResult>
    ): StorageTask<TResult> {
        pausedListeners.add(executor to listener)
        if (isPaused()) {
            val snap = snapshot
            executor.execute { listener.onPaused(snap) }
        }
        return this
    }

    open fun removeOnPausedListener(listener: OnPausedListener<in TResult>): StorageTask<TResult> {
        pausedListeners.removeIf { it.second == listener }
        return this
    }

    protected fun notifyProgress(currentSnapshot: TResult) {
        for ((executor, listener) in progressListeners) {
            if (executor != null) {
                executor.execute { listener.onProgress(currentSnapshot) }
            } else {
                listener.onProgress(currentSnapshot)
            }
        }
    }

    protected fun notifyPaused(currentSnapshot: TResult) {
        for ((executor, listener) in pausedListeners) {
            if (executor != null) {
                executor.execute { listener.onPaused(currentSnapshot) }
            } else {
                listener.onPaused(currentSnapshot)
            }
        }
    }

    private fun registerTerminalCallback(callback: (StorageTask<TResult>) -> Unit) {
        val runNow = synchronized(stateLock) {
            if (!completeState) {
                terminalCallbacks.add(callback)
                false
            } else {
                true
            }
        }
        if (runNow) {
            callback(this)
        }
    }

    override fun addOnSuccessListener(listener: OnSuccessListener<in TResult>): StorageTask<TResult> {
        registerTerminalCallback { task ->
            if (task.isSuccessful()) listener.onSuccess(task.getResult())
        }
        return this
    }

    override fun addOnSuccessListener(
        executor: Executor,
        listener: OnSuccessListener<in TResult>
    ): StorageTask<TResult> {
        return addOnSuccessListener { res -> executor.execute { listener.onSuccess(res) } }
    }

    override fun addOnFailureListener(listener: OnFailureListener): StorageTask<TResult> {
        registerTerminalCallback { task ->
            val ex = task.getException()
            if (!task.isSuccessful() && ex != null) {
                listener.onFailure(ex)
            }
        }
        return this
    }

    override fun addOnFailureListener(
        executor: Executor,
        listener: OnFailureListener
    ): StorageTask<TResult> {
        return addOnFailureListener { ex -> executor.execute { listener.onFailure(ex) } }
    }

    override fun addOnCompleteListener(listener: OnCompleteListener<TResult>): StorageTask<TResult> {
        registerTerminalCallback { task -> listener.onComplete(task) }
        return this
    }

    override fun addOnCompleteListener(
        executor: Executor,
        listener: OnCompleteListener<TResult>
    ): StorageTask<TResult> {
        return addOnCompleteListener { task -> executor.execute { listener.onComplete(task) } }
    }

    override fun addOnCanceledListener(listener: OnCanceledListener): StorageTask<TResult> {
        registerTerminalCallback { task ->
            if (task.isCanceled()) listener.onCanceled()
        }
        return this
    }

    override fun addOnCanceledListener(
        executor: Executor,
        listener: OnCanceledListener
    ): StorageTask<TResult> {
        return addOnCanceledListener { executor.execute { listener.onCanceled() } }
    }
}
