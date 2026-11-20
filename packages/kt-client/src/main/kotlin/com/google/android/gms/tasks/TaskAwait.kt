package com.google.android.gms.tasks

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

suspend fun <T> Task<T>.await(): T {
    if (isComplete) {
        val e = exception
        if (e != null) throw e
        if (isCanceled) throw CancellationException("Task $this was cancelled normally.")
        return getResult()
    }
    return suspendCancellableCoroutine { cont ->
        addOnCompleteListener { task ->
            val e = task.exception
            if (e == null) {
                if (task.isCanceled) {
                    cont.cancel()
                } else {
                    cont.resume(task.getResult())
                }
            } else {
                cont.resumeWithException(e)
            }
        }
    }
}
