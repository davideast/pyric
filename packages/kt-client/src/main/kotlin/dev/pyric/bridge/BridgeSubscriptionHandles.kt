package dev.pyric.bridge

import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.channels.Channel

/**
 * Emitted on a subscription opened with `includeMetadataChanges` when the bridge
 * connection drops after the subscription delivered a value. The listener reports
 * its last snapshot again with `isFromCache` set.
 */
object BridgeSubscriptionGap

internal data class BridgeSequencedSnapshot(
    val value: Any?,
    val wireSeq: Long
)

/** Synchronous handle for a live bridge subscription (D7, D10). */
internal interface BridgeSubscriptionHandle {
    fun cancel()
}

internal class SequencedSubscriptionHandle(
    val channel: Channel<BridgeSequencedSnapshot>,
    private val inner: BridgeSubscriptionHandle
) : BridgeSubscriptionHandle {
    override fun cancel() {
        inner.cancel()
    }
}

/**
 * Shared client callbacks passed into [BridgeSubscriptionManager] so
 * [PyricBridgeClient] does not repeat the same wiring across every entry point.
 */
internal class BridgeSubscriptionWiring(
    val isAttached: () -> Boolean,
    val ensureConnected: suspend () -> Unit,
    val keepsOnConnectFailure: () -> Boolean,
    val sendJson: (String) -> Unit,
    val jsonSerializer: (Any?) -> String
) {
    fun open(
        manager: BridgeSubscriptionManager,
        scope: kotlinx.coroutines.CoroutineScope,
        appCheckTokenProvider: (suspend () -> String?)?,
        target: Any,
        actAs: Map<String, Any?>? = null,
        includeMetadataChanges: Boolean = false,
        listenSource: String? = null,
        onValue: (Any?) -> Unit,
        onWireError: (FirebaseFirestoreException) -> Unit,
        onCloseError: (FirebaseFirestoreException) -> Unit
    ): BridgeSubscriptionHandle = manager.openSubscription(
        target = target,
        actAs = actAs,
        includeMetadataChanges = includeMetadataChanges,
        listenSource = listenSource,
        appCheckTokenProvider = appCheckTokenProvider,
        scope = scope,
        isAttached = isAttached,
        ensureConnected = ensureConnected,
        keepsSubscriptionOnConnectFailure = keepsOnConnectFailure,
        sendJson = sendJson,
        jsonSerializer = jsonSerializer,
        onValue = onValue,
        onWireError = onWireError,
        onCloseError = onCloseError
    )
}
