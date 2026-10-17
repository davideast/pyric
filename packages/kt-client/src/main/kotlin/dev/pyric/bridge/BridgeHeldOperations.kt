package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/** How long an operation issued while the client is not attached is held. */
internal const val BRIDGE_HOLD_TIMEOUT_MS = 10_000L

private const val HOLD_EXPIRED =
    "The bridge connection was not restored within 10 seconds. The request was not sent."

/** An operation the client admitted. Tickets follow issue order. */
internal class HeldOperation(
    val ticket: Long,
    val start: () -> BridgeDispatch,
    /** The [System.nanoTime] at which its hold deadline passes, measured from issue. */
    val deadlineAt: Long
) {
    /** Completes with the sent operation's result, or fails if it is never sent. */
    val sent = CompletableDeferred<CompletableDeferred<Any?>>()
    var deadline: Job? = null
    /** Set when the caller was cancelled, so a refused send is not held again. */
    var withdrawn = false
}

/** An admitted operation. A direct one goes straight to the socket through [BridgeHeldOperations.sendDirect]. */
internal class Admission(val entry: HeldOperation, val direct: Boolean)

/** A release that waits for the sends started before it to return. */
private class ParkedRelease(val epoch: Long, val failure: FirebaseFirestoreException?)

private sealed interface ReleaseStep {
    class Send(val entry: HeldOperation) : ReleaseStep
    class FailAll(val entries: List<HeldOperation>, val failure: FirebaseFirestoreException) : ReleaseStep
}

/**
 * Operations the bridge client holds while it is not attached (ADR-0019 decision
 * 7). Each is held for at most the hold deadline from the moment it was issued.
 * It is then sent once, in issue order, after the client's restore traffic, or
 * fails once and is never sent.
 *
 * An operation whose frame the transport refused never left the device, so it is
 * held too, in the place it was admitted (amendment 2026-10-17). A release waits
 * until every send already handed to the transport has returned, so a refusal
 * that returns late still goes ahead of operations admitted after it.
 *
 * Lock order: the client's lock, then this one. No send runs under this lock.
 */
internal class BridgeHeldOperations(private val scope: CoroutineScope) {
    private val lock = Any()
    /** Held operations in ticket order. */
    private val held = ArrayList<HeldOperation>()
    /** True while operations go straight to the socket. */
    private var open = false
    /** Changes on every interruption, so a release for an earlier attach stops. */
    private var epoch = 0L
    private var terminal: FirebaseFirestoreException? = null
    /** The close that permitted no retry. A refusal that returns after it fails with it. */
    private var closeFailure: FirebaseFirestoreException? = null
    private var lastTicket = 0L
    /** Sends handed to the transport that have not returned yet. */
    private var unsettled = 0
    private var parked: ParkedRelease? = null

    /**
     * Admits an operation in issue order. While the client is attached and nothing
     * is held, it is direct and the caller sends it with [sendDirect]. Otherwise it
     * is held.
     */
    fun admit(timeoutMs: Long, start: () -> BridgeDispatch): Admission {
        val deadlineAt = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        synchronized(lock) {
            terminal?.let { throw it }
            lastTicket += 1
            val entry = HeldOperation(lastTicket, start, deadlineAt)
            if (open) {
                unsettled += 1
                return Admission(entry, direct = true)
            }
            insertLocked(entry)
            return Admission(entry, direct = false)
        }
    }

    /** Sends a direct operation. If the transport refuses it, it is held in its admission place. */
    fun sendDirect(entry: HeldOperation) {
        sendAndSettle(entry)
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
            parked = null
            closeFailure = null
        }
    }

    /**
     * Sends every held operation once, in issue order, then lets operations go
     * straight to the socket. With [failure], every held operation fails with it
     * instead and none is sent. Stops if the connection was interrupted after
     * [releaseEpoch] was read, or if the transport refuses a send; the rest stay
     * held. While a send started earlier has not returned, the release waits and
     * that send's return resumes it.
     */
    fun release(releaseEpoch: Long, failure: FirebaseFirestoreException?) {
        while (true) {
            val step = synchronized(lock) { nextReleaseStepLocked(releaseEpoch, failure) } ?: return
            when (step) {
                is ReleaseStep.FailAll -> step.entries.forEach { it.sent.completeExceptionally(step.failure) }
                is ReleaseStep.Send -> if (sendAndSettle(step.entry)) return
            }
        }
    }

    /** Fails every held operation once with [error]; none is sent. */
    fun fail(error: FirebaseFirestoreException) {
        val failed = synchronized(lock) {
            closeFailure = error
            takeAllLocked()
        }
        failed.forEach { it.sent.completeExceptionally(error) }
    }

    /** Fails every held operation once, and every later one at issue. */
    fun dispose(error: FirebaseFirestoreException) {
        val failed = synchronized(lock) {
            terminal = error
            open = false
            epoch += 1
            parked = null
            takeAllLocked()
        }
        failed.forEach { it.sent.completeExceptionally(error) }
    }

    private fun nextReleaseStepLocked(releaseEpoch: Long, failure: FirebaseFirestoreException?): ReleaseStep? {
        if (releaseEpoch != epoch) return null
        if (unsettled > 0) {
            parked = ParkedRelease(releaseEpoch, failure)
            return null
        }
        if (held.isEmpty()) {
            open = true
            closeFailure = null
            return null
        }
        if (failure != null) return ReleaseStep.FailAll(takeAllLocked(), failure)
        unsettled += 1
        return ReleaseStep.Send(takeFirstLocked())
    }

    /**
     * Hands [entry] to the transport outside the lock; the caller counted it in
     * [unsettled]. Returns true when the transport refused it.
     */
    private fun sendAndSettle(entry: HeldOperation): Boolean {
        val outcome = startOrFail(entry)
        val refused = outcome == BridgeDispatch.Refused
        val failure: FirebaseFirestoreException?
        val resume: ParkedRelease?
        synchronized(lock) {
            unsettled -= 1
            failure = if (refused) terminal ?: closeFailure else null
            val holdsAgain = refused && failure == null && !entry.withdrawn
            if (holdsAgain) {
                // Later operations are held behind it instead of being refused one by one.
                open = false
                insertLocked(entry)
            }
            resume = if (unsettled == 0) parked.also { parked = null } else null
        }
        if (outcome is BridgeDispatch.Started) entry.sent.complete(outcome.result)
        if (failure != null) entry.sent.completeExceptionally(failure)
        resume?.let { release(it.epoch, it.failure) }
        return refused
    }

    private fun startOrFail(entry: HeldOperation): BridgeDispatch? =
        try {
            entry.start()
        } catch (e: Throwable) {
            entry.sent.completeExceptionally(e)
            null
        }

    /** Inserts [entry] at its ticket and arms its deadline from issue. */
    private fun insertLocked(entry: HeldOperation) {
        val firstLater = held.indexOfFirst { it.ticket > entry.ticket }
        held.add(firstLater.takeIf { it >= 0 } ?: held.size, entry)
        val remainingMs = TimeUnit.NANOSECONDS.toMillis(entry.deadlineAt - System.nanoTime())
        entry.deadline = scope.launch {
            delay(remainingMs)
            expire(entry)
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
        val removed = synchronized(lock) {
            entry.withdrawn = true
            held.remove(entry)
        }
        if (removed) entry.deadline?.cancel()
    }

    private fun takeFirstLocked(): HeldOperation {
        val first = held.removeAt(0)
        first.deadline?.cancel()
        return first
    }

    private fun takeAllLocked(): List<HeldOperation> {
        val taken = held.toList()
        held.clear()
        taken.forEach { it.deadline?.cancel() }
        return taken
    }
}
