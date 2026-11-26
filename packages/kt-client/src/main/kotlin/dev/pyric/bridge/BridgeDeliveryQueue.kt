package dev.pyric.bridge

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.FlowCollector
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Unbounded, single-threaded FIFO delivery queue owned by one [PyricBridgeClient].
 *
 * All app-facing subscription callbacks, `.info` transitions, rules denials, and
 * flow turn handoffs run here in exact enqueue order (ADR-0019 D8). Enqueuing is
 * non-blocking so socket reader threads never stall and bursts never drop frames.
 */
internal class BridgeDeliveryQueue(namePrefix: String = "pyric-bridge-delivery") {
    @Volatile
    private var deliveryThread: Thread? = null
    private val closed = AtomicBoolean(false)

    private val executor: ExecutorService = ThreadPoolExecutor(
        1,
        1,
        5L,
        TimeUnit.SECONDS,
        LinkedBlockingQueue()
    ) { runnable ->
        Thread(
            {
                deliveryThread = Thread.currentThread()
                runnable.run()
            },
            "$namePrefix-${threadCounter.incrementAndGet()}"
        ).apply {
            isDaemon = true
        }
    }.apply {
        allowCoreThreadTimeOut(true)
    }

    fun isOnDeliveryThread(): Boolean = Thread.currentThread() === deliveryThread

    /**
     * Appends [task] to the unbounded FIFO queue without blocking.
     * Returns false only after [shutdown].
     */
    fun enqueue(task: () -> Unit): Boolean {
        if (closed.get()) return false
        return try {
            executor.execute {
                try {
                    task()
                } catch (_: Throwable) {
                    // Never allow an app callback failure to kill the delivery worker.
                }
            }
            true
        } catch (_: RejectedExecutionException) {
            false
        }
    }

    fun shutdown() {
        if (closed.compareAndSet(false, true)) {
            executor.shutdown()
        }
    }

    companion object {
        private val threadCounter = AtomicInteger(0)
    }
}

/**
 * Serialized handoff from [BridgeDeliveryQueue] to a cold [kotlinx.coroutines.flow.Flow]
 * collector. The delivery thread waits for the collector's `emit` to finish before
 * dispatching the next event on any other subscription, preserving cross-subscription
 * frame order (D8) even across concurrent `Dispatchers.IO` collectors.
 *
 * Cancellation or [failImmediate] unblocks any waiting delivery turn immediately so
 * teardown never stalls the queue and buffered frames never reach app code after close.
 */
internal class BridgeFlowHandoff<T> {
    private sealed interface Event<out T> {
        class Value<T>(val item: T, val ack: CountDownLatch) : Event<T>
        class WireError(val cause: Throwable) : Event<Nothing>
        data object Complete : Event<Nothing>
    }

    private val lock = Any()
    private val channel = Channel<Event<T>>(Channel.UNLIMITED)
    private val pendingAcks = ArrayList<CountDownLatch>()
    private var closed = false
    @Volatile
    private var immediateError: Throwable? = null

    /** Called on the delivery thread; waits until the collector finishes `emit` or closes. */
    fun deliverValue(item: T) {
        val ack = CountDownLatch(1)
        val sent = synchronized(lock) {
            if (closed) {
                false
            } else {
                pendingAcks.add(ack)
                channel.trySend(Event.Value(item, ack)).isSuccess
            }
        }
        if (!sent) return
        try {
            ack.await()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    /** Called on the delivery thread for an in-order stream error (e.g. wire `__error`). */
    fun deliverError(cause: Throwable) {
        synchronized(lock) {
            if (closed) return
            closed = true
            channel.trySend(Event.WireError(cause))
            channel.close()
        }
    }

    /** Called on the delivery thread for clean stream completion (e.g. Firestore terminate). */
    fun deliverComplete() {
        synchronized(lock) {
            if (closed) return
            closed = true
            channel.trySend(Event.Complete)
            channel.close()
        }
    }

    /**
     * Called synchronously from any thread on client close/disconnect (D6).
     * Immediately drops undelivered turns and unblocks the delivery thread.
     */
    fun failImmediate(cause: Throwable) {
        val toRelease = synchronized(lock) {
            if (closed) return
            closed = true
            immediateError = cause
            val copy = pendingAcks.toList()
            pendingAcks.clear()
            channel.close(cause)
            copy
        }
        for (ack in toRelease) {
            ack.countDown()
        }
    }

    /** Called from the collector's `finally` on cancellation or exit. */
    fun cancel() {
        val toRelease = synchronized(lock) {
            closed = true
            val copy = pendingAcks.toList()
            pendingAcks.clear()
            channel.close()
            copy
        }
        for (ack in toRelease) {
            ack.countDown()
        }
    }

    suspend fun collectLoop(collector: FlowCollector<T>) {
        while (true) {
            immediateError?.let { throw it }
            val result = channel.receiveCatching()
            immediateError?.let { throw it }
            if (result.isClosed) {
                result.exceptionOrNull()?.let { throw it }
                return
            }
            when (val event = result.getOrThrow()) {
                is Event.Value -> {
                    try {
                        immediateError?.let { throw it }
                        collector.emit(event.item)
                    } catch (c: CancellationException) {
                        throw c
                    } finally {
                        completeAck(event.ack)
                    }
                }
                is Event.WireError -> throw event.cause
                Event.Complete -> return
            }
        }
    }

    private fun completeAck(ack: CountDownLatch) {
        synchronized(lock) {
            pendingAcks.remove(ack)
        }
        ack.countDown()
    }
}
