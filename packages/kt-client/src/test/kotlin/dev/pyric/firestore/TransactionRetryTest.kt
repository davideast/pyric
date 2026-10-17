package dev.pyric.firestore

import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Transaction
import dev.pyric.bridge.BridgeConnectionState
import dev.pyric.bridge.FakeReconnectBridge
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * `runTransaction` retries only when the host reports contention: ABORTED,
 * ALREADY_EXISTS or FAILED_PRECONDITION, the codes Android's TransactionRunner
 * names. Every other failure settles the Task once. A `txnCommit` in flight at a
 * drop may already be applied, so it is never sent again (delivery contract D4),
 * and an exception from the app's update function is the app's, so it is never
 * retried either.
 */
class TransactionRetryTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        FirebaseApp.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "txn-retry-app",
            FirebaseOptions.Builder()
                .setProjectId("txn-retry")
                .setApiKey("txn-retry-key")
                .setApplicationId("txn-retry-app-id")
                .build()
        )
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        firestore = FirebaseFirestore(client, app, "(default)")
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `a txnCommit in flight at a drop is sent once and fails with the connection-lost error`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        val resent = CompletableDeferred<Unit>()
        bridge.onFrame = { if (commitCount() > 1) resent.complete(Unit) }

        val task = firestore.runTransaction(setRoom())
        until { commitCount() == 1 }
        bridge.current.drop()

        // Either outcome ends the wait: the Task settling, or a second commit frame.
        withTimeout(10_000) {
            select<Unit> {
                settled(task).onAwait { }
                resent.onAwait { }
            }
        }

        assertEquals(1, commitCount(), "txnCommit frames")
        val error = task.exception as FirebaseFirestoreException
        assertEquals(FirebaseFirestoreException.Code.UNAVAILABLE, error.code)
        assertEquals(
            "The bridge connection was lost. Requests already sent may have completed; check state before retrying.",
            error.message
        )
    }

    @Test
    fun `an exception from the app's update function is not retried`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        val runs = AtomicInteger(0)
        val appFailure = IllegalStateException("app update failed")

        val task = firestore.runTransaction(Transaction.Function<Any?> {
            runs.incrementAndGet()
            throw appFailure
        })
        withTimeout(10_000) { settled(task).await() }

        assertEquals(1, runs.get(), "update function runs")
        assertSame(appFailure, task.exception)
        assertEquals(0, commitCount(), "txnCommit frames")
    }

    @Test
    fun `a commit denied by rules is not retried`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        answerCommits("permission-denied", "permission-denied")

        val task = firestore.runTransaction(setRoom())
        withTimeout(10_000) { settled(task).await() }

        assertEquals(1, commitCount(), "txnCommit frames")
        val error = task.exception as FirebaseFirestoreException
        assertEquals(FirebaseFirestoreException.Code.PERMISSION_DENIED, error.code)
    }

    @Test
    fun `a commit the host aborts for contention is retried`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        answerCommits("aborted", null)

        val task = firestore.runTransaction(setRoom())
        withTimeout(10_000) { settled(task).await() }

        assertTrue(task.isSuccessful, "task failed with ${task.exception}")
        assertEquals(2, commitCount(), "txnCommit frames")
    }

    private fun setRoom() = Transaction.Function<Any?> { t ->
        t.set(firestore.document("rooms/a"), mapOf("v" to 1))
        null
    }

    private fun commitCount() = bridge.opsNamed("txnCommit").size

    /** Answers each `txnCommit` in turn: an error code, or null for success. */
    private fun answerCommits(vararg codes: String?) {
        val next = AtomicInteger(0)
        bridge.onFrame = { frame ->
            @Suppress("UNCHECKED_CAST")
            val method = (frame["op"] as? Map<String, Any?>)?.get("method")
            if (method == "txnCommit") {
                val code = codes.getOrNull(next.getAndIncrement())
                val reply = if (code == null) {
                    mapOf("type" to "worker-res", "id" to frame["id"], "ok" to true, "value" to null)
                } else {
                    mapOf(
                        "type" to "worker-res",
                        "id" to frame["id"],
                        "ok" to false,
                        "error" to mapOf("code" to code, "message" to "host said $code")
                    )
                }
                val socket = bridge.current
                Thread { socket.deliver(reply) }.start()
            }
        }
    }

    private fun settled(task: Task<*>): CompletableDeferred<Unit> {
        val done = CompletableDeferred<Unit>()
        task.addOnCompleteListener { done.complete(Unit) }
        return done
    }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) { while (!condition()) delay(5) }
    }
}
