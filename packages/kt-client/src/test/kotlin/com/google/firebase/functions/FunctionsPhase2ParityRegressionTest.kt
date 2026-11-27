package com.google.firebase.functions

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.sun.net.httpserver.HttpServer
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class FunctionsPhase2ParityRegressionTest {
    private lateinit var server: HttpServer
    private var port: Int = 0

    @BeforeEach
    fun setUp() {
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        port = server.address.port
    }

    @AfterEach
    fun tearDown() {
        server.stop(0)
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun `P2-K14 non-2xx error envelope with status OK is never downgraded to null`() {
        val serializer = FunctionsSerializer()
        val err = FirebaseFunctionsException.fromResponse(
            defaultCode = FirebaseFunctionsException.Code.INTERNAL,
            body = """{"error":{"status":"OK","message":"spoofed"},"data":"ok"}""",
            serializer = serializer
        )
        assertNotNull(err)
        assertEquals(FirebaseFunctionsException.Code.INTERNAL, err!!.code)
    }

    @Test
    fun `P2-K09a & P2-K11 derives gateway origin from app sharedBridgeClient and does not eagerly initialize FirebaseAuth`() {
        val app = FirebaseApp.initializeApp(
            "fn-gateway-app",
            FirebaseOptions.Builder()
                .setProjectId("fn-p2")
                .setApiKey("k")
                .setApplicationId("1:1:android:abc")
                .build()
        )
        val bridge = PyricBridgeClient(url = "ws://127.0.0.1:$port/__pyric/sandbox")
        app.getOrCreateBridgeClient(bridge)

        val functions = FirebaseFunctions.getInstance(app)
        val resolvedUrl = functions.getURL("echo")
        assertTrue(resolvedUrl.toString().startsWith("http://127.0.0.1:$port/"))
        assertNull(FirebaseAuth.existingInstanceOrNull(app))
        bridge.terminate()
    }

    @Test
    fun `P2-K09b executeStream delivers over 100 chunks and terminal Result without dropping under slow collector`() = runBlocking {
        server.createContext("/") { ex ->
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(200, 0)
            ex.responseBody.bufferedWriter().use { w ->
                for (i in 1..120) {
                    w.write("""data: {"message":$i}""" + "\n\n")
                }
                w.write("""data: {"result":"done"}""" + "\n\n")
                w.flush()
            }
        }
        server.start()

        val app = FirebaseApp.initializeApp(
            "fn-stream-app",
            FirebaseOptions.Builder()
                .setProjectId("fn-p2")
                .setApiKey("k")
                .setApplicationId("1:1:android:abc")
                .build()
        )
        val functions = FirebaseFunctions.getInstance(app)
        functions.useEmulator("127.0.0.1", port)

        val items = mutableListOf<StreamResponse>()
        functions.getHttpsCallable("burst").stream().collect { item ->
            if (items.size < 5) delay(15)
            items.add(item)
        }
        assertEquals(121, items.size)
        val last = items.last() as StreamResponse.Result
        assertEquals("done", last.result.data)
    }

    @Test
    fun `P2-F06a dispose cancels active executeStream callbackFlow with CANCELLED`() = runBlocking {
        val connected = CountDownLatch(1)
        val release = CountDownLatch(1)
        server.createContext("/") { ex ->
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(200, 0)
            ex.responseBody.write("data: {\"message\":\"hi\"}\n\n".toByteArray())
            ex.responseBody.flush()
            connected.countDown()
            release.await(5, TimeUnit.SECONDS)
            runCatching { ex.close() }
        }
        server.start()

        val app = FirebaseApp.initializeApp(
            "fn-dispose-app",
            FirebaseOptions.Builder()
                .setProjectId("fn-p2")
                .setApiKey("k")
                .setApplicationId("1:1:android:abc")
                .build()
        )
        val functions = FirebaseFunctions.getInstance(app)
        functions.useEmulator("127.0.0.1", port)

        val caught = AtomicReference<Throwable?>(null)
        val job = launch(kotlinx.coroutines.Dispatchers.Default) {
            functions.getHttpsCallable("hang").stream()
                .catch { caught.set(it) }
                .toList()
        }
        assertTrue(connected.await(5, TimeUnit.SECONDS))
        functions.dispose()
        job.join()
        release.countDown()
        val err = caught.get() as? FirebaseFunctionsException
        assertNotNull(err)
        assertEquals(FirebaseFunctionsException.Code.CANCELLED, err!!.code)
    }
}
