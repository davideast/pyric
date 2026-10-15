package dev.pyric.bridge

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * How often an attached client sends `ping` (ADR-0019, amendment "clients send a
 * heartbeat"). It matches the web client's `HOSTED_HEARTBEAT_INTERVAL_MS`.
 */
internal const val BRIDGE_HEARTBEAT_INTERVAL_MS = 15_000L

/** A socket that delivers no frame of any kind for this long is a drop (three heartbeats). */
internal const val BRIDGE_LIVENESS_TIMEOUT_MS = 45_000L

/**
 * The heartbeat of one attached socket. It pings at once, then before each later
 * ping checks how long the socket has been silent. Silence past the timeout is
 * reported once and ends the heartbeat. The check runs before the send, so a
 * process resumed after a long pause reports the drop instead of pinging a socket
 * the host has already closed.
 */
internal class BridgeHeartbeat(
    private val scope: CoroutineScope,
    private val clock: () -> Long = System::nanoTime
) {
    private val lock = Any()
    private var job: Job? = null
    @Volatile private var lastHeardAt = 0L

    /** Any frame from the socket counts, not only `pong`. */
    fun heard() {
        lastHeardAt = clock()
    }

    /**
     * Replaces any running heartbeat. [ping] sends one frame on the socket and
     * returns false when that socket is no longer the current one, which ends the
     * heartbeat quietly. [onSilent] reports the drop; it also runs when [ping] throws.
     */
    fun start(intervalMs: Long, timeoutMs: Long, ping: () -> Boolean, onSilent: () -> Unit) {
        synchronized(lock) {
            job?.cancel()
            heard()
            job = scope.launch { beat(intervalMs, timeoutMs, ping, onSilent) }
        }
    }

    fun stop() {
        synchronized(lock) {
            job?.cancel()
            job = null
        }
    }

    private suspend fun beat(intervalMs: Long, timeoutMs: Long, ping: () -> Boolean, onSilent: () -> Unit) {
        while (true) {
            val isSilent = silentMs() >= timeoutMs
            if (isSilent) {
                onSilent()
                return
            }
            val sent = try {
                ping()
            } catch (_: Throwable) {
                onSilent()
                return
            }
            if (!sent) return
            // The next check falls at the timeout when no frame arrives before it.
            val untilTimeout = timeoutMs - silentMs()
            delay(intervalMs.coerceAtMost(untilTimeout).coerceAtLeast(0L))
        }
    }

    private fun silentMs(): Long = (clock() - lastHeardAt) / 1_000_000L
}
