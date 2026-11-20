package com.google.android.gms.tasks

fun interface OnTokenCanceledListener {
    fun onCanceled()
}

abstract class CancellationToken {
    abstract fun isCancellationRequested(): Boolean
    abstract fun onCanceledRequested(listener: OnTokenCanceledListener): CancellationToken
}

class CancellationTokenSource {
    private val impl = TokenImpl()

    val token: CancellationToken
        get() = impl

    fun cancel() {
        impl.cancel()
    }

    private class TokenImpl : CancellationToken() {
        private val lock = Any()
        private var canceled: Boolean = false
        private val listeners = mutableListOf<OnTokenCanceledListener>()

        override fun isCancellationRequested(): Boolean = synchronized(lock) { canceled }

        override fun onCanceledRequested(listener: OnTokenCanceledListener): CancellationToken {
            val invokeNow = synchronized(lock) {
                if (canceled) {
                    true
                } else {
                    listeners.add(listener)
                    false
                }
            }
            if (invokeNow) {
                listener.onCanceled()
            }
            return this
        }

        fun cancel() {
            val pending = synchronized(lock) {
                if (canceled) return
                canceled = true
                val copy = ArrayList(listeners)
                listeners.clear()
                copy
            }
            for (listener in pending) {
                listener.onCanceled()
            }
        }
    }
}
