package dev.pyric.functions

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableOptions
import com.google.firebase.functions.StreamResponse
import com.google.firebase.functions.functions
import com.google.firebase.functions.getHttpsCallable
import com.google.firebase.functions.getHttpsCallableFromUrl
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.net.InetSocketAddress
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FirebaseFunctionsTest {
    private lateinit var server: HttpServer
    private var serverPort: Int = 0
    private val recordedRequests = CopyOnWriteArrayList<RecordedHttpCall>()
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private val limitedMintSeq = AtomicInteger(0)

    data class RecordedHttpCall(
        val method: String,
        val pathAndQuery: String,
        val headers: Map<String, String>,
        val body: String
    )

    @BeforeEach
    fun setUp() {
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        recordedRequests.clear()
        limitedMintSeq.set(0)

        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.executor = Executors.newCachedThreadPool()
        server.createContext("/") { exchange -> handleHttp(exchange) }
        server.start()
        serverPort = server.address.port

        transport = InMemoryBridgeTransport()
        transport.onServerReceive { raw ->
            val msg = JsonCodec.decodeMap(raw)
            when (msg["type"]) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    transport.sendToClient("""{"type":"worker-snap","subId":"$subId","value":null}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    when (op["method"] as String) {
                        "auth.signInEmail" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"user":{"uid":"u-fn-1","email":"fn@example.com","isAnonymous":false,"providerId":"firebase"}}}"""
                            )
                        }
                        "auth.getIdTokenResult" -> {
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"mock-auth-jwt-123","claims":{"sub":"u-fn-1"},"signInProvider":"password"}}"""
                            )
                        }
                        "appCheck.getToken" -> {
                            val exp = System.currentTimeMillis() + 3_600_000L
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"appcheck-std-jwt","expireTimeMillis":$exp}}"""
                            )
                        }
                        "appCheck.getLimitedUseToken" -> {
                            val seq = limitedMintSeq.incrementAndGet()
                            val exp = System.currentTimeMillis() + 300_000L
                            transport.sendToClient(
                                """{"type":"worker-res","id":"$id","ok":true,"value":{"token":"appcheck-lim-$seq","expireTimeMillis":$exp}}"""
                            )
                        }
                        else -> {
                            transport.sendToClient("""{"type":"worker-res","id":"$id","ok":true,"value":null}""")
                        }
                    }
                }
            }
        }
        bridgeClient = PyricBridgeClient(transport)
    }

    @AfterEach
    fun tearDown() {
        server.stop(0)
        (server.executor as? java.util.concurrent.ExecutorService)?.shutdownNow()
        FirebaseFunctions.clearInstancesForTest()
        FirebaseAuth.clearInstancesForTest()
        FirebaseAppCheck.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun handleHttp(exchange: HttpExchange) {
        val body = exchange.requestBody.readBytes().toString(StandardCharsets.UTF_8)
        val headers = LinkedHashMap<String, String>()
        for ((k, values) in exchange.requestHeaders) {
            if (values.isNotEmpty()) {
                headers[k.lowercase()] = values.first()
            }
        }
        val rawQuery = exchange.requestURI.rawQuery
        val pathAndQuery = if (rawQuery != null) {
            "${exchange.requestURI.rawPath}?$rawQuery"
        } else {
            exchange.requestURI.rawPath
        }
        recordedRequests.add(
            RecordedHttpCall(
                method = exchange.requestMethod,
                pathAndQuery = pathAndQuery,
                headers = headers,
                body = body
            )
        )

        val path = exchange.requestURI.rawPath
        when {
            path.endsWith("/echo") -> {
                val decoded = JsonCodec.decodeMap(body)
                val response = JsonCodec.encodeToString(
                    mapOf(
                        "result" to mapOf(
                            "received" to decoded["data"],
                            "bigLong" to mapOf(
                                "@type" to "type.googleapis.com/google.protobuf.Int64Value",
                                "value" to "9007199254740993"
                            ),
                            "authHeader" to headers["authorization"],
                            "appCheckHeader" to headers["x-firebase-appcheck"],
                            "path" to pathAndQuery
                        )
                    )
                )
                sendJson(exchange, 200, response)
            }
            path.endsWith("/failStructured") -> {
                val response = JsonCodec.encodeToString(
                    mapOf(
                        "error" to mapOf(
                            "status" to "ALREADY_EXISTS",
                            "message" to "Slug already exists",
                            "details" to mapOf(
                                "retryAfterSec" to mapOf(
                                    "@type" to "type.googleapis.com/google.protobuf.Int64Value",
                                    "value" to "30"
                                )
                            )
                        )
                    )
                )
                sendJson(exchange, 409, response)
            }
            path.endsWith("/slow") -> {
                Thread.sleep(400)
                sendJson(exchange, 200, """{"result":{"ok":true}}""")
            }
            path.endsWith("/sseStream") -> {
                exchange.responseHeaders.set("Content-Type", "text/event-stream")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.use { out ->
                    out.write(": heartbeat\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.write("""data: {"message":"chunk-1"}""".toByteArray(StandardCharsets.UTF_8))
                    out.write("\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                    out.write("""data: {"message":{"step":2}}""".toByteArray(StandardCharsets.UTF_8))
                    out.write("\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                    out.write("""data: {"result":{"done":true,"total":2}}""".toByteArray(StandardCharsets.UTF_8))
                    out.write("\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                }
            }
            path.endsWith("/sseFail") -> {
                exchange.responseHeaders.set("Content-Type", "text/event-stream")
                exchange.sendResponseHeaders(200, 0)
                exchange.responseBody.use { out ->
                    out.write("""data: {"message":"first-before-err"}""".toByteArray(StandardCharsets.UTF_8))
                    out.write("\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                    out.write(
                        """data: {"error":{"status":"FAILED_PRECONDITION","message":"quota tripped","details":{"limit":5}}}"""
                            .toByteArray(StandardCharsets.UTF_8)
                    )
                    out.write("\n\n".toByteArray(StandardCharsets.UTF_8))
                    out.flush()
                }
            }
            else -> {
                sendJson(exchange, 404, """{"error":{"status":"NOT_FOUND","message":"Unknown function"}}""")
            }
        }
    }

    private fun sendJson(exchange: HttpExchange, status: Int, json: String) {
        val bytes = json.toByteArray(StandardCharsets.UTF_8)
        exchange.responseHeaders.set("Content-Type", "application/json")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun newApp(name: String = "fn-test-app"): FirebaseApp {
        return FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("demo-fn-unit")
                .setApiKey("fake-api-key")
                .setApplicationId("1:123:android:fnunit")
                .build()
        )
    }

    @Test
    fun `getInstance KTX caching customDomain URL rewriting and off-machine refusal`() {
        val app = newApp()
        assertSame(FirebaseFunctions.getInstance(), Firebase.functions)
        assertSame(FirebaseFunctions.getInstance(app), Firebase.functions(app))
        assertSame(
            FirebaseFunctions.getInstance(app, "europe-west1"),
            Firebase.functions(app, "europe-west1")
        )
        assertNotSame(Firebase.functions(app), Firebase.functions(app, "europe-west1"))

        val fn = Firebase.functions(app, "europe-west1")
        fn.useEmulator("127.0.0.1", serverPort)

        val res = Tasks.await(
            fn.getHttpsCallable("echo").call(mapOf("count" to 9007199254740993L, "items" to listOf(1, "two", true)))
        )
        @Suppress("UNCHECKED_CAST")
        val data = res.data as Map<String, Any?>
        assertEquals("/demo-fn-unit/europe-west1/echo", data["path"])
        assertEquals(9007199254740993L, data["bigLong"])
        @Suppress("UNCHECKED_CAST")
        val received = data["received"] as Map<String, Any?>
        assertEquals(9007199254740993L, received["count"])

        val wireBody = JsonCodec.decodeMap(recordedRequests[0].body)
        @Suppress("UNCHECKED_CAST")
        val wireData = wireBody["data"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val encodedCount = wireData["count"] as Map<String, Any?>
        assertEquals("type.googleapis.com/google.protobuf.Int64Value", encodedCount["@type"])
        assertEquals("9007199254740993", encodedCount["value"])

        // cloudfunctions.net and run.app URLs rewrite through emulator/gateway origin
        val cfUrl = URL("https://us-central1-demo-fn-unit.cloudfunctions.net/echo")
        val cfRes = Tasks.await(fn.getHttpsCallableFromUrl(cfUrl).call("via-cf"))
        @Suppress("UNCHECKED_CAST")
        assertEquals("/demo-fn-unit/us-central1/echo", (cfRes.data as Map<String, Any?>)["path"])

        val runUrl = URL("https://echo-abc12-uc.a.run.app")
        val runRes = Tasks.await(fn.getHttpsCallableFromUrl(runUrl).call("via-run"))
        @Suppress("UNCHECKED_CAST")
        assertEquals(
            "/demo-fn-unit/europe-west1/echo?__pyric_run_service=1",
            (runRes.data as Map<String, Any?>)["path"]
        )

        // Custom domain on loopback
        val customFn = FirebaseFunctions.getInstance(app, "http://127.0.0.1:$serverPort/rewritten")
        assertEquals("us-central1", customFn.region)
        assertEquals("http://127.0.0.1:$serverPort/rewritten", customFn.customDomain)
        val customRes = Tasks.await(customFn.getHttpsCallable("echo").call(null))
        @Suppress("UNCHECKED_CAST")
        assertEquals("/rewritten/echo", (customRes.data as Map<String, Any?>)["path"])

        // Off-machine URL is refused with Code.UNAVAILABLE before any HTTP call
        val countBefore = recordedRequests.size
        val offMachineErr = assertThrows(ExecutionException::class.java) {
            Tasks.await(
                fn.getHttpsCallableFromUrl(URL("https://external.example.com/echo")).call(null)
            )
        }
        val fnEx = offMachineErr.cause as FirebaseFunctionsException
        assertEquals(FirebaseFunctionsException.Code.UNAVAILABLE, fnEx.code)
        assertEquals(countBefore, recordedRequests.size)
    }

    @Test
    fun `attaches Auth Bearer and standard or limited-use AppCheck headers`() {
        val app = newApp("fn-headers-app")
        val auth = FirebaseAuth.getInstance(app, bridgeClient)
        val appCheck = FirebaseAppCheck.getInstance(app, bridgeClient)
        val fn = FirebaseFunctions.getInstance(app)
        fn.useEmulator("127.0.0.1", serverPort)

        // Signed out & no AppCheck provider installed -> neither header sent
        val anonRes = Tasks.await(fn.getHttpsCallable("echo").call("hello"))
        @Suppress("UNCHECKED_CAST")
        val anonMap = anonRes.data as Map<String, Any?>
        assertNull(anonMap["authHeader"])
        assertNull(anonMap["appCheckHeader"])

        // Sign in & install AppCheck provider
        Tasks.await(auth.signInWithEmailAndPassword("fn@example.com", "Secret123!"))
        appCheck.installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance(), false)

        val authedRes = Tasks.await(fn.getHttpsCallable("echo").call("authed"))
        @Suppress("UNCHECKED_CAST")
        val authedMap = authedRes.data as Map<String, Any?>
        assertEquals("Bearer mock-auth-jwt-123", authedMap["authHeader"])
        assertEquals("appcheck-std-jwt", authedMap["appCheckHeader"])

        // Limited-use App Check tokens via Kotlin DSL and HttpsCallableOptions.Builder
        val limRef = fn.getHttpsCallable("echo") {
            limitedUseAppCheckTokens = true
        }
        val lim1 = Tasks.await(limRef.call("one")).data as Map<*, *>
        val lim2 = Tasks.await(
            fn.getHttpsCallable(
                "echo",
                HttpsCallableOptions.Builder().setLimitedUseAppCheckTokens(true).build()
            ).call("two")
        ).data as Map<*, *>
        assertEquals("appcheck-lim-1", lim1["appCheckHeader"])
        assertEquals("appcheck-lim-2", lim2["appCheckHeader"])
        assertNotEquals(lim1["appCheckHeader"], lim2["appCheckHeader"])
    }

    @Test
    fun `maps structured HttpsError details timeout and non-finite encoding errors`() {
        val app = newApp("fn-errors-app")
        val fn = FirebaseFunctions.getInstance(app)
        fn.useEmulator("127.0.0.1", serverPort)

        assertEquals(FirebaseFunctionsException.Code.ALREADY_EXISTS, FirebaseFunctionsException.Code.fromValue(6))
        assertEquals(FirebaseFunctionsException.Code.UNAUTHENTICATED, FirebaseFunctionsException.Code.fromHttpStatus(401))

        val errExec = assertThrows(ExecutionException::class.java) {
            Tasks.await(fn.getHttpsCallable("failStructured").call(mapOf("slug" to "taken")))
        }
        val structured = errExec.cause as FirebaseFunctionsException
        assertEquals(FirebaseFunctionsException.Code.ALREADY_EXISTS, structured.code)
        assertEquals("Slug already exists", structured.message)
        @Suppress("UNCHECKED_CAST")
        val details = structured.details as Map<String, Any?>
        assertEquals(30L, details["retryAfterSec"])

        // withTimeout clones without mutating original reference
        val baseRef = fn.getHttpsCallable("slow")
        assertEquals(70_000L, baseRef.getTimeout())
        val shortRef = baseRef.withTimeout(80L, TimeUnit.MILLISECONDS)
        assertEquals(70_000L, baseRef.getTimeout())
        assertEquals(80L, shortRef.getTimeout())

        val timeoutExec = assertThrows(ExecutionException::class.java) {
            Tasks.await(shortRef.call())
        }
        val timeoutEx = timeoutExec.cause as FirebaseFunctionsException
        assertEquals(FirebaseFunctionsException.Code.DEADLINE_EXCEEDED, timeoutEx.code)

        val nanExec = assertThrows(ExecutionException::class.java) {
            Tasks.await(fn.getHttpsCallable("echo").call(Double.NaN))
        }
        assertTrue(nanExec.cause is IllegalArgumentException)
    }

    @Test
    fun `streams SSE Message and Result frames and propagates mid-stream HttpsError`() = runBlocking {
        val app = newApp("fn-stream-app")
        val fn = FirebaseFunctions.getInstance(app)
        fn.useEmulator("127.0.0.1", serverPort)

        val events = fn.getHttpsCallable("sseStream").stream(mapOf("prompt" to "hi")).toList()
        assertEquals(3, events.size)
        assertTrue(events[0] is StreamResponse.Message)
        assertEquals("chunk-1", (events[0] as StreamResponse.Message).message.data)
        assertTrue(events[1] is StreamResponse.Message)
        assertEquals(mapOf("step" to 2), (events[1] as StreamResponse.Message).message.data)
        assertTrue(events[2] is StreamResponse.Result)
        assertEquals(mapOf("done" to true, "total" to 2), (events[2] as StreamResponse.Result).result.data)

        // Early cancellation via take(1) closes cleanly
        val firstOnly = fn.getHttpsCallableFromUrl(URL("http://127.0.0.1:$serverPort/demo-fn-unit/us-central1/sseStream"))
            .stream()
            .take(1)
            .toList()
        assertEquals(1, firstOnly.size)

        // Mid-stream error surfaces FirebaseFunctionsException after first chunk
        val partial = mutableListOf<StreamResponse>()
        val midStreamErr = assertThrows(FirebaseFunctionsException::class.java) {
            runBlocking {
                fn.getHttpsCallable("sseFail").stream().collect { item ->
                    partial.add(item)
                }
            }
        }
        assertEquals(1, partial.size)
        assertEquals("first-before-err", (partial[0] as StreamResponse.Message).message.data)
        assertEquals(FirebaseFunctionsException.Code.FAILED_PRECONDITION, midStreamErr.code)
        assertEquals("quota tripped", midStreamErr.message)
        assertEquals(mapOf("limit" to 5), midStreamErr.details)
        assertFalse(partial.any { it is StreamResponse.Result })
    }
}
