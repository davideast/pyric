package dev.pyric.database

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
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
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * An RTDB transaction settles once (delivery contract D3). An exception thrown by
 * the app's own `onComplete` is the app's, so it leaves the transaction as an
 * uncaught exception, as it does on Android, and never comes back as a second
 * completion with an error.
 */
class TransactionCompletesOnceTest {
    private val bridge = FakeReconnectBridge()
    private lateinit var app: FirebaseApp
    private lateinit var client: PyricBridgeClient
    private lateinit var database: FirebaseDatabase
    private val previousHandler = Thread.getDefaultUncaughtExceptionHandler()
    private val uncaught = CompletableDeferred<Throwable>()

    @BeforeEach
    fun setUp() {
        Thread.setDefaultUncaughtExceptionHandler { _, e -> uncaught.complete(e) }
        FirebaseApp.clearInstancesForTest()
        app = FirebaseApp.initializeApp(
            "txn-once-app",
            FirebaseOptions.Builder()
                .setProjectId("txn-once")
                .setApiKey("txn-once-key")
                .setApplicationId("txn-once-app-id")
                .build()
        )
        client = PyricBridgeClient(
            url = "ws://127.0.0.1:5174/__pyric/sandbox",
            transportFactory = bridge,
            reconnectDelayMs = { 5L }
        )
        database = FirebaseDatabase(client, app, "https://txn-once-default-rtdb.firebaseio.com")
        answerTransactionOps()
    }

    @AfterEach
    fun tearDown() {
        runBlocking { client.disconnect() }
        bridge.shutdown()
        FirebaseApp.clearInstancesForTest()
        Thread.setDefaultUncaughtExceptionHandler(previousHandler)
    }

    @Test
    fun `onComplete runs once when the app's onComplete throws`() = runBlocking {
        until { client.connectionState == BridgeConnectionState.ATTACHED }
        val errors = CopyOnWriteArrayList<DatabaseError?>()
        val appFailure = IllegalStateException("app callback failed")
        val secondCompletion = CompletableDeferred<Unit>()

        database.getReference("counter").runTransaction(object : Transaction.Handler {
            override fun doTransaction(currentData: MutableData): Transaction.Result {
                currentData.value = 2
                return Transaction.success(currentData)
            }

            override fun onComplete(error: DatabaseError?, committed: Boolean, currentData: DataSnapshot?) {
                errors.add(error)
                if (errors.size > 1) secondCompletion.complete(Unit)
                if (error == null) throw appFailure
            }
        })

        // Either outcome ends the wait: the app's exception escaping, or a second call.
        withTimeout(10_000) {
            select<Unit> {
                uncaught.onAwait { }
                secondCompletion.onAwait { }
            }
        }

        assertEquals(1, errors.size, "onComplete calls, with errors $errors")
        assertNull(errors.single())
        assertEquals(appFailure, uncaught.await())
    }

    /** The host's answer to one get and one commit: value 1, then committed at 2. */
    private fun answerTransactionOps() {
        bridge.onFrame = { frame ->
            @Suppress("UNCHECKED_CAST")
            val method = (frame["op"] as? Map<String, Any?>)?.get("method")
            val value = when (method) {
                "rtdb.get" -> mapOf("value" to 1)
                "rtdb.transactionCommit" -> mapOf("committed" to true, "snapshot" to mapOf("value" to 2))
                else -> null
            }
            if (value != null) {
                val socket = bridge.current
                Thread {
                    socket.deliver(mapOf("type" to "worker-res", "id" to frame["id"], "ok" to true, "value" to value))
                }.start()
            }
        }
    }

    private suspend fun until(condition: () -> Boolean) {
        withTimeout(10_000) { while (!condition()) delay(5) }
    }
}
