package com.google.android.gms.tasks

import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

object Tasks {

    fun <T> forResult(result: T): Task<T> {
        val tcs = TaskCompletionSource<T>()
        tcs.setResult(result)
        return tcs.task
    }

    fun <T> forException(exception: Exception): Task<T> {
        val tcs = TaskCompletionSource<T>()
        tcs.setException(exception)
        return tcs.task
    }

    fun <T> await(task: Task<T>): T {
        if (task.isComplete) {
            if (task.isSuccessful) return task.getResult()
            throw ExecutionException(task.exception)
        }
        val latch = CountDownLatch(1)
        task.addOnCompleteListener { latch.countDown() }
        latch.await()
        if (task.isSuccessful) return task.getResult()
        throw ExecutionException(task.exception)
    }

    fun <T> await(task: Task<T>, timeout: Long, unit: TimeUnit): T {
        if (task.isComplete) {
            if (task.isSuccessful) return task.getResult()
            throw ExecutionException(task.exception)
        }
        val latch = CountDownLatch(1)
        task.addOnCompleteListener { latch.countDown() }
        if (!latch.await(timeout, unit)) {
            throw TimeoutException("Timed out waiting for Task")
        }
        if (task.isSuccessful) return task.getResult()
        throw ExecutionException(task.exception)
    }
}
