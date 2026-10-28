package dev.pyric.database.internal

import dev.pyric.bridge.BridgeConnectionState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * The `.info` tree the client serves itself (ADR-0019, amendment "every client
 * serves `.info` locally"). Listeners and reads on these paths never reach the
 * host and are not replayed on re-attach.
 */
internal const val INFO_ROOT = ".info"

/** The bridge handshake carries no server timestamp, so the offset is always 0. */
internal const val SERVER_TIME_OFFSET = 0L

/** A path is under `/.info` when its first segment is `.info`, as `isInfoPath` in writable-path.ts tests it. */
internal fun isInfoPath(path: String): Boolean =
    path.trim('/').substringBefore('/') == INFO_ROOT

/** Connected while the bridge is attached and the database's network flag is on. */
internal fun isConnected(state: BridgeConnectionState, online: Boolean): Boolean =
    state == BridgeConnectionState.ATTACHED && online

/** The value served at [path], a path under `/.info`. */
internal fun infoValue(path: String, connected: Boolean): Any? {
    val rest = path.trim('/').removePrefix(INFO_ROOT).trim('/')
    return when (rest) {
        "" -> mapOf("connected" to connected, "serverTimeOffset" to SERVER_TIME_OFFSET)
        "connected" -> connected
        "serverTimeOffset" -> SERVER_TIME_OFFSET
        else -> null
    }
}

/**
 * The values served at [path]: the current one first, then one per change.
 * `true` is derived from the bridge's `ATTACHED` state, which it reaches after
 * the Auth restore; an operation issued on it is held until the listener replay
 * and every held operation have been sent.
 */
internal fun infoValues(
    path: String,
    states: Flow<BridgeConnectionState>,
    online: Flow<Boolean>
): Flow<Any?> =
    combine(states, online, ::isConnected)
        .distinctUntilChanged()
        .map { connected -> infoValue(path, connected) }
        .distinctUntilChanged()
