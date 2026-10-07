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

    private fun subscribeOnce(
        manager: BridgeSubscriptionManager,
        isAttached: () -> Boolean,
        send: (String) -> Unit
    ) = manager.subscribe(
        target = "authState",
        isAttached = isAttached,
        ensureConnected = {},
        keepsSubscriptionOnConnectFailure = { true },
        sendJson = send,
        jsonSerializer = JsonCodec::encodeToString
    )

    @Test
    fun `a subscription registered while an attach completes is sent once`() = runBlocking {
        val manager = BridgeSubscriptionManager()
        val frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val send: (String) -> Unit = { frames.add(JsonCodec.decodeMap(it)) }
        val attached = AtomicBoolean(false)

        // The whole attach, restore included, finishes after the subscription is
        // registered and before it checks whether the client is attached.
        val isAttached: () -> Boolean = {
            if (attached.compareAndSet(false, true)) {
                manager.restoreAll(manager.beginAttach(), send, JsonCodec::encodeToString)
            }
            true
        }

        val job = launch { subscribeOnce(manager, isAttached, send).collect {} }
        delay(100)

        assertEquals(1, frames.count { it["type"] == "worker-sub" })
        job.cancel()
    }

    @Test
    fun `a subscription that sees the attach before its restore runs is sent once`() = runBlocking {
        val manager = BridgeSubscriptionManager()
        val frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val send: (String) -> Unit = { frames.add(JsonCodec.decodeMap(it)) }

        // The client reports itself attached; its restore has not run yet.
        val attach = manager.beginAttach()
        val job = launch { subscribeOnce(manager, { true }, send).collect {} }
        delay(100)
        manager.restoreAll(attach, send, JsonCodec::encodeToString)

        assertEquals(1, frames.count { it["type"] == "worker-sub" })
        job.cancel()
    }

    @Test
    fun `every attach re-sends a live subscription once`() = runBlocking {
        val manager = BridgeSubscriptionManager()
        val frames = CopyOnWriteArrayList<Map<String, Any?>>()
        val send: (String) -> Unit = { frames.add(JsonCodec.decodeMap(it)) }

        val first = manager.beginAttach()
        val job = launch { subscribeOnce(manager, { true }, send).collect {} }
        delay(100)
        manager.restoreAll(first, send, JsonCodec::encodeToString)
        manager.restoreAll(manager.beginAttach(), send, JsonCodec::encodeToString)
        manager.restoreAll(manager.beginAttach(), send, JsonCodec::encodeToString)

        assertEquals(3, frames.count { it["type"] == "worker-sub" })
        job.cancel()
    }
}
