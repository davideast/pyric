package com.google.firebase.storage

import com.google.android.gms.tasks.Task
import java.util.concurrent.Executor

abstract class CancellableTask<StateT> : Task<StateT>() {
    abstract override fun isCanceled(): Boolean
    abstract fun isInProgress(): Boolean
    abstract fun cancel(): Boolean

    @get:JvmName("inProgressProp")
    val isInProgress: Boolean
        get() = isInProgress()

    abstract fun addOnProgressListener(
        listener: OnProgressListener<in StateT>
    ): CancellableTask<StateT>

    abstract fun addOnProgressListener(
        executor: Executor,
        listener: OnProgressListener<in StateT>
    ): CancellableTask<StateT>
}
