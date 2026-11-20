package com.google.android.gms.tasks

import java.util.concurrent.CancellationException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

object Tasks {

    @JvmStatic
    fun <T> forResult(result: T): Task<T> {
        val tcs = TaskCompletionSource<T>()
        tcs.setResult(result)
        return tcs.task
    }

    @JvmStatic
    fun <T> forException(exception: Exception): Task<T> {
        val tcs = TaskCompletionSource<T>()
        tcs.setException(exception)
        return tcs.task
    }

    @JvmStatic
    fun <T> forCanceled(): Task<T> {
        val tcs = TaskCompletionSource<T>()
        tcs.trySetCanceled()
        return tcs.task
    }

    @JvmStatic
    fun <T> await(task: Task<T>): T {
        if (task.isComplete) {
            return unwrapCompleted(task)
        }
        val latch = CountDownLatch(1)
        task.addOnCompleteListener { latch.countDown() }
        latch.await()
        return unwrapCompleted(task)
    }

    @JvmStatic
    fun <T> await(task: Task<T>, timeout: Long, unit: TimeUnit): T {
        if (task.isComplete) {
            return unwrapCompleted(task)
        }
        val latch = CountDownLatch(1)
        task.addOnCompleteListener { latch.countDown() }
        if (!latch.await(timeout, unit)) {
            throw TimeoutException("Timed out waiting for Task")
        }
        return unwrapCompleted(task)
    }

    private fun <T> unwrapCompleted(task: Task<T>): T {
        if (task.isSuccessful) return task.getResult()
        if (task.isCanceled) throw CancellationException("Task is already canceled")
        throw ExecutionException(task.exception)
    }
}
