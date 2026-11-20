package com.google.android.gms.tasks

import java.util.concurrent.CancellationException
import java.util.concurrent.Executor

class TaskCompletionSource<TResult>() {

    private val impl = TaskImpl<TResult>()
    val task: Task<TResult> get() = impl

    constructor(cancellationToken: CancellationToken) : this() {
        cancellationToken.onCanceledRequested { impl.trySetCanceled() }
    }

    fun setResult(result: TResult) {
        impl.trySetResult(result)
    }

    fun setException(e: Exception) {
        impl.trySetException(e)
    }

    fun trySetResult(result: TResult): Boolean = impl.trySetResult(result)

    fun trySetException(e: Exception): Boolean = impl.trySetException(e)

    internal fun trySetCanceled(): Boolean = impl.trySetCanceled()

    private class TaskImpl<T> : Task<T>() {
        private val lock = Any()
        private var completeState: Boolean = false
        private var successfulState: Boolean = false
        private var canceledState: Boolean = false
        private var resultValue: T? = null
        private var exceptionValue: Exception? = null

        override fun isComplete(): Boolean = synchronized(lock) { completeState }
        override fun isSuccessful(): Boolean = synchronized(lock) { successfulState }
        override fun isCanceled(): Boolean = synchronized(lock) { canceledState }

        @Suppress("UNCHECKED_CAST")
        override fun getResult(): T = synchronized(lock) {
            if (canceledState) throw CancellationException("Task is already canceled")
            if (successfulState) return resultValue as T
            throw exceptionValue ?: IllegalStateException("Task is not yet complete")
        }

        override fun getException(): Exception? = synchronized(lock) { exceptionValue }

        private val listeners = mutableListOf<(Task<T>) -> Unit>()

        fun trySetResult(res: T): Boolean {
            val callbacks = synchronized(lock) {
                if (completeState) return false
                completeState = true
                successfulState = true
                resultValue = res
                val copy = ArrayList(listeners)
                listeners.clear()
                copy
            }
            callbacks.forEach { it(this) }
            return true
        }

        fun trySetException(e: Exception): Boolean {
            val callbacks = synchronized(lock) {
                if (completeState) return false
                completeState = true
                successfulState = false
                exceptionValue = e
                val copy = ArrayList(listeners)
                listeners.clear()
                copy
            }
            callbacks.forEach { it(this) }
            return true
        }

        fun trySetCanceled(): Boolean {
            val callbacks = synchronized(lock) {
                if (completeState) return false
                completeState = true
                successfulState = false
                canceledState = true
                val copy = ArrayList(listeners)
                listeners.clear()
                copy
            }
            callbacks.forEach { it(this) }
            return true
        }

        @Suppress("UNCHECKED_CAST")
        override fun <X : Throwable> getResult(exceptionType: Class<X>): T {
            synchronized(lock) {
                if (canceledState) throw CancellationException("Task is already canceled")
                if (successfulState) return resultValue as T
                if (exceptionType.isInstance(exceptionValue)) throw exceptionType.cast(exceptionValue)
                throw exceptionValue ?: IllegalStateException("Task failed without exception")
            }
        }

        override fun addOnSuccessListener(listener: OnSuccessListener<in T>): Task<T> {
            val shouldInvoke: Boolean
            val r: T?
            synchronized(lock) {
                if (!completeState) {
                    listeners.add { task ->
                        if (task.isSuccessful()) listener.onSuccess(task.getResult())
                    }
                    return this
                }
                shouldInvoke = successfulState
                r = resultValue
            }
            if (shouldInvoke) {
                @Suppress("UNCHECKED_CAST")
                listener.onSuccess(r as T)
            }
            return this
        }

        override fun addOnSuccessListener(executor: Executor, listener: OnSuccessListener<in T>): Task<T> {
            return addOnSuccessListener { res -> executor.execute { listener.onSuccess(res) } }
        }

        override fun addOnFailureListener(listener: OnFailureListener): Task<T> {
            val shouldInvoke: Boolean
            val ex: Exception?
            synchronized(lock) {
                if (!completeState) {
                    listeners.add { task ->
                        val taskEx = task.getException()
                        if (!task.isSuccessful() && !task.isCanceled() && taskEx != null) {
                            listener.onFailure(taskEx)
                        }
                    }
                    return this
                }
                shouldInvoke = !successfulState && !canceledState
                ex = exceptionValue
            }
            if (shouldInvoke && ex != null) {
                listener.onFailure(ex)
            }
            return this
        }

        override fun addOnFailureListener(executor: Executor, listener: OnFailureListener): Task<T> {
            return addOnFailureListener { ex -> executor.execute { listener.onFailure(ex) } }
        }

        override fun addOnCompleteListener(listener: OnCompleteListener<T>): Task<T> {
            val shouldInvoke: Boolean
            synchronized(lock) {
                if (!completeState) {
                    listeners.add { task -> listener.onComplete(task) }
                    return this
                }
                shouldInvoke = true
            }
            if (shouldInvoke) {
                listener.onComplete(this)
            }
            return this
        }

        override fun addOnCompleteListener(executor: Executor, listener: OnCompleteListener<T>): Task<T> {
            return addOnCompleteListener { task -> executor.execute { listener.onComplete(task) } }
        }

        override fun addOnCanceledListener(listener: OnCanceledListener): Task<T> {
            val shouldInvoke: Boolean
            synchronized(lock) {
                if (!completeState) {
                    listeners.add { task ->
                        if (task.isCanceled()) listener.onCanceled()
                    }
                    return this
                }
                shouldInvoke = canceledState
            }
            if (shouldInvoke) {
                listener.onCanceled()
            }
            return this
        }

        override fun addOnCanceledListener(executor: Executor, listener: OnCanceledListener): Task<T> {
            return addOnCanceledListener { executor.execute { listener.onCanceled() } }
        }
    }
}
