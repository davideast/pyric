package com.google.android.gms.tasks

import java.util.concurrent.Executor

fun interface OnSuccessListener<TResult> {
    fun onSuccess(result: TResult)
}

fun interface OnFailureListener {
    fun onFailure(e: Exception)
}

fun interface OnCompleteListener<TResult> {
    fun onComplete(task: Task<TResult>)
}

abstract class Task<TResult> {
    abstract fun isComplete(): Boolean
    abstract fun isSuccessful(): Boolean
    abstract fun isCanceled(): Boolean
    abstract fun getResult(): TResult
    abstract fun <X : Throwable> getResult(exceptionType: Class<X>): TResult
    abstract fun getException(): Exception?

    @get:JvmName("completeProp")
    val isComplete: Boolean get() = isComplete()

    @get:JvmName("successfulProp")
    val isSuccessful: Boolean get() = isSuccessful()

    @get:JvmName("canceledProp")
    val isCanceled: Boolean get() = isCanceled()

    @get:JvmName("resultProp")
    val result: TResult get() = getResult()

    @get:JvmName("exceptionProp")
    val exception: Exception? get() = getException()

    abstract fun addOnSuccessListener(listener: OnSuccessListener<in TResult>): Task<TResult>
    abstract fun addOnSuccessListener(executor: Executor, listener: OnSuccessListener<in TResult>): Task<TResult>
    abstract fun addOnFailureListener(listener: OnFailureListener): Task<TResult>
    abstract fun addOnFailureListener(executor: Executor, listener: OnFailureListener): Task<TResult>
    abstract fun addOnCompleteListener(listener: OnCompleteListener<TResult>): Task<TResult>
    abstract fun addOnCompleteListener(executor: Executor, listener: OnCompleteListener<TResult>): Task<TResult>

    open fun <TContinuationResult> continueWith(continuation: (Task<TResult>) -> TContinuationResult): Task<TContinuationResult> {
        val tcs = TaskCompletionSource<TContinuationResult>()
        addOnCompleteListener { task ->
            try {
                val res = continuation(task)
                tcs.setResult(res)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }
}
