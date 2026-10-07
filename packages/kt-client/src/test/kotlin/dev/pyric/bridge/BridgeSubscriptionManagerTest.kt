package dev.pyric.bridge

import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * An attach marks the client attached and then re-sends the live subscriptions.
 * A subscription opened in that window must reach the bridge once.
 */
class BridgeSubscriptionManagerTest {
    private val manager = BridgeSubscriptionManager()
    private val frames = CopyOnWriteArrayList<String>()
    private val send: (String) -> Unit = { frames.add(it) }
    private val scope = CoroutineScope(Dispatchers.Unconfined)

    private fun subFrames(): List<String> =
        frames.filter { JsonCodec.decodeMap(it)["type"] == BridgeProtocol.TYPE_WORKER_SUB }

    private fun open(isAttached: () -> Boolean) {
        scope.launch {
            manager.subscribe(
                target = "authState",
                isAttached = isAttached,
                ensureConnected = {},
                keepsSubscriptionOnConnectFailure = { true },
                sendJson = send,
                jsonSerializer = JsonCodec::encodeToString
            ).collect {}
        }
    }

    @Test
    fun `a subscription re-sent by an attach before its own attach check is sent once`() {
        open(isAttached = {
            manager.restoreAll(manager.beginAttach(), send, JsonCodec::encodeToString)
            true
        })
        assertEquals(1, subFrames().size, "worker-sub frames: ${subFrames()}")
        scope.cancel()
    }

    @Test
    fun `a subscription sent after the attach flag is set and before the re-send is sent once`() {
        val epoch = manager.beginAttach()
        open(isAttached = { true })
        manager.restoreAll(epoch, send, JsonCodec::encodeToString)
        assertEquals(1, subFrames().size, "worker-sub frames: ${subFrames()}")
        scope.cancel()
    }

    @Test
    fun `a later attach re-sends a subscription already sent on an earlier attach`() {
        val first = manager.beginAttach()
        open(isAttached = { true })
        manager.restoreAll(first, send, JsonCodec::encodeToString)
        manager.restoreAll(manager.beginAttach(), send, JsonCodec::encodeToString)
        assertEquals(2, subFrames().size, "worker-sub frames: ${subFrames()}")
        scope.cancel()
    }
}
