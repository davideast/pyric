package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long an operation issued while the client is not attached is held. */
internal const val BRIDGE_HOLD_TIMEOUT_MS = 10_000L

private const val HOLD_EXPIRED =
    "The bridge connection was not restored within 10 seconds. The request was not sent."

/** An operation issued while the client was not attached. */
internal class HeldOperation(val start: () -> CompletableDeferred<Any?>) {
    /** Completes with the sent operation's result, or fails if it is never sent. */
    val sent = CompletableDeferred<CompletableDeferred<Any?>>()
    var deadline: Job? = null
}

/**
 * Operations the bridge client holds while it is not attached (ADR-0019 decision
 * 7). Each is held for at most the hold deadline from the moment it was issued.
 * It is then sent once, in issue order, after the client's restore traffic, or
 * fails once and is never sent.
 */
internal class BridgeHeldOperations(private val scope: CoroutineScope) {
    private val lock = Any()
    private val held = ArrayDeque<HeldOperation>()
    /** True while operations go straight to the socket. */
    private var open = false
    /** Changes on every interruption, so a release for an earlier attach stops. */
    private var epoch = 0L
    private var terminal: FirebaseFirestoreException? = null

    /** Returns null when the client is attached and nothing is held; the caller sends directly. */
    fun hold(timeoutMs: Long, start: () -> CompletableDeferred<Any?>): HeldOperation? {
        val entry: HeldOperation
        synchronized(lock) {
            terminal?.let { throw it }
            if (open) return null
            entry = HeldOperation(start)
            held.addLast(entry)
            entry.deadline = scope.launch {
                delay(timeoutMs)
                expire(entry)
            }
        }
        return entry
    }

    /** Waits for [entry] to be sent and answered. A cancelled caller's operation is never sent. */
    suspend fun await(entry: HeldOperation): Any? {
        val sentOperation = try {
            entry.sent.await()
        } catch (e: CancellationException) {
            withdraw(entry)
            throw e
        }
        return sentOperation.await()
    }

    fun epoch(): Long = synchronized(lock) { epoch }

    /** Holds operations issued from now until the next release. */
    fun interrupt() {
        synchronized(lock) {
            open = false
            epoch += 1
        }
    }

    /**
     * Sends every held operation once, in issue order, then lets operations go
     * straight to the socket. With [failure], every held operation fails with it
     * instead and none is sent. Stops if the connection was interrupted after
     * [releaseEpoch] was read; the rest stay held.
     */
    fun release(releaseEpoch: Long, failure: FirebaseFirestoreException?) {
        while (true) {
            val batch = synchronized(lock) {
                if (releaseEpoch != epoch) return
                if (held.isEmpty()) {
                    open = true
                    return
                }
                takeAllLocked()
            }
            if (failure != null) {
                batch.forEach { it.sent.completeExceptionally(failure) }
            } else {
                batch.forEach(::send)
            }
        }
    }

    /** Fails every held operation once with [error]; none is sent. */
    fun fail(error: FirebaseFirestoreException) {
        val failed = synchronized(lock) { takeAllLocked() }
        failed.forEach { it.sent.completeExceptionally(error) }
    }

    /** Fails every held operation once, and every later one at issue. */
    fun dispose(error: FirebaseFirestoreException) {
        val failed = synchronized(lock) {
            terminal = error
            open = false
            epoch += 1
            takeAllLocked()
        }
        failed.forEach { it.sent.completeExceptionally(error) }
    }

    private fun send(entry: HeldOperation) {
        try {
            entry.sent.complete(entry.start())
        } catch (e: Throwable) {
            entry.sent.completeExceptionally(e)
        }
    }

    private fun expire(entry: HeldOperation) {
        val stillHeld = synchronized(lock) { held.remove(entry) }
        if (!stillHeld) return
        entry.sent.completeExceptionally(
            FirebaseFirestoreException(HOLD_EXPIRED, FirebaseFirestoreException.Code.UNAVAILABLE)
        )
    }

    private fun withdraw(entry: HeldOperation) {
        val removed = synchronized(lock) { held.remove(entry) }
        if (removed) entry.deadline?.cancel()
    }

    private fun takeAllLocked(): List<HeldOperation> {
        val taken = held.toList()
        held.clear()
        taken.forEach { it.deadline?.cancel() }
        return taken
    }
}
