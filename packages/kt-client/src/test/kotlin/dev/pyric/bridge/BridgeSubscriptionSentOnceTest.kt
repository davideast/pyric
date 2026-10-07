package dev.pyric.bridge

import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

class BridgeSubscriptionSentOnceTest {

    @Test
    fun `a subscription registered while an attach completes is sent once`() = runBlocking {
        val manager = BridgeSubscriptionManager()
        val frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val send: (String) -> Unit = { frames.add(JsonCodec.decodeMap(it)) }
        val attached = AtomicBoolean(false)

        // The attach finishes after the subscription is registered and before
        // the subscription checks whether the client is attached.
        val isAttached: () -> Boolean = {
            if (attached.compareAndSet(false, true)) manager.restoreAll(send, JsonCodec::encodeToString)
            true
        }

        val job = launch {
            manager.subscribe(
                target = "authState",
                isAttached = isAttached,
                ensureConnected = {},
                keepsSubscriptionOnConnectFailure = { true },
                sendJson = send,
                jsonSerializer = JsonCodec::encodeToString
            ).collect {}
        }
        delay(100)

        assertEquals(1, frames.count { it["type"] == "worker-sub" })
        job.cancel()
    }

    @Test
    fun `every attach re-sends a live subscription once`() = runBlocking {
        val manager = BridgeSubscriptionManager()
        val frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val send: (String) -> Unit = { frames.add(JsonCodec.decodeMap(it)) }

        val job = launch {
            manager.subscribe(
                target = "authState",
                isAttached = { true },
                ensureConnected = {},
                keepsSubscriptionOnConnectFailure = { true },
                sendJson = send,
                jsonSerializer = JsonCodec::encodeToString
            ).collect {}
        }
        delay(100)
        manager.restoreAll(send, JsonCodec::encodeToString)
        manager.restoreAll(send, JsonCodec::encodeToString)

        assertEquals(3, frames.count { it["type"] == "worker-sub" })
        job.cancel()
    }
}
