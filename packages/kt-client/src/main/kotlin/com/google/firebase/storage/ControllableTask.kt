package com.google.firebase.storage

import java.util.concurrent.Executor

abstract class ControllableTask<StateT> : CancellableTask<StateT>() {
    abstract fun isPaused(): Boolean
    abstract fun pause(): Boolean
    abstract fun resume(): Boolean

    @get:JvmName("pausedProp")
    val isPaused: Boolean
        get() = isPaused()

    abstract fun addOnPausedListener(
        listener: OnPausedListener<in StateT>
    ): ControllableTask<StateT>

    abstract fun addOnPausedListener(
        executor: Executor,
        listener: OnPausedListener<in StateT>
    ): ControllableTask<StateT>
}
