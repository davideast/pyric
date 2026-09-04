package dev.pyric.example.todo.stress

import dev.pyric.example.todo.network.PyricBridgeHealth
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.ServerSocket
import java.net.SocketTimeoutException

/**
 * Empirical stress testing of [PyricBridgeHealth] handling:
 * - Connection refused
 * - HTTP status codes (200, 403, 404, 500)
 * - Malformed, partial, HTML, and schema-mismatched JSON payloads
 * - Cleartext security exception handling and timeout
 */
class PyricBridgeHealthStressTest {

    private fun clientWithResponse(
        code: Int,
        body: String,
        message: String = "OK"
    ): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                Response.Builder()
                    .request(request)
                    .protocol(Protocol.HTTP_1_1)
                    .code(code)
                    .message(message)
                    .body(body.toResponseBody("application/json".toMediaTypeOrNull()))
                    .build()
            }
            .build()
    }

    private fun clientWithException(throwable: Throwable): OkHttpClient {
        return OkHttpClient.Builder()
            .addInterceptor { _ ->
                throw throwable
            }
            .build()
    }

    @Test
    fun testRealSocketConnectionRefused() = runBlocking {
        // Find an unused port that immediately refuses connections
        val unusedPort = ServerSocket(0).use { it.localPort }
        val health = PyricBridgeHealth(healthUrl = "http://127.0.0.1:$unusedPort/__pyric/health")
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Cannot connect to Pyric bridge", status.message)
        assertTrue(status.details?.contains("adb reverse") == true)
    }

    @Test
    fun testSimulatedConnectException() = runBlocking {
        val health = PyricBridgeHealth(
            httpClient = clientWithException(ConnectException("Connection refused"))
        )
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Cannot connect to Pyric bridge", status.message)
    }

    @Test
    fun testValidSandboxConnectedResponse() = runBlocking {
        val client = clientWithResponse(
            code = 200,
            body = """{"sandboxConnected":true,"instanceId":"pyric-instance-888"}"""
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertTrue(status.isReachable)
        assertTrue(status.isSandboxConnected)
        assertEquals("Connected to Pyric Sandbox", status.message)
        assertEquals("Instance: pyric-instance-888", status.details)
    }

    @Test
    fun testValidSandboxNotConnectedResponse() = runBlocking {
        val client = clientWithResponse(
            code = 200,
            body = """{"sandboxConnected":false,"instanceId":null}"""
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertTrue(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Waiting for browser sandbox", status.message)
        assertTrue(status.details?.contains("Open http://localhost:5174") == true)
    }

    @Test
    fun testEmptyResponseBody() = runBlocking {
        val client = clientWithResponse(code = 200, body = "")
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertTrue(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Waiting for browser sandbox", status.message)
    }

    @Test
    fun testMalformedJsonPayload() = runBlocking {
        val client = clientWithResponse(
            code = 200,
            body = """{"sandboxConnected": incomplete json..."""
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Unexpected Health Check Failure", status.message)
        assertNotNull(status.details)
    }

    @Test
    fun testHtmlErrorPageResponse() = runBlocking {
        val client = clientWithResponse(
            code = 200,
            body = """<!DOCTYPE html><html><head><title>Sign In</title></head><body>Login required</body></html>"""
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Unexpected Health Check Failure", status.message)
    }

    @Test
    fun testUnexpectedTypesInJsonPayload() = runBlocking {
        // sandboxConnected is string "true" instead of boolean true
        val client = clientWithResponse(
            code = 200,
            body = """{"sandboxConnected":"true","instanceId":12345}"""
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertTrue(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Waiting for browser sandbox", status.message)
    }

    @Test
    fun testHttp403ForbiddenDnsRebindingGuard() = runBlocking {
        val client = clientWithResponse(
            code = 403,
            body = "Forbidden",
            message = "Forbidden"
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("DNS-Rebinding Guard Rejected Host", status.message)
        assertTrue(status.details?.contains("Do not connect to 10.0.2.2") == true)
    }

    @Test
    fun testHttp500InternalServerError() = runBlocking {
        val client = clientWithResponse(
            code = 500,
            body = "Internal error",
            message = "Internal Server Error"
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Bridge health returned status 500", status.message)
    }

    @Test
    fun testHttp404NotFound() = runBlocking {
        val client = clientWithResponse(
            code = 404,
            body = "Not Found",
            message = "Not Found"
        )
        val health = PyricBridgeHealth(httpClient = client)
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Bridge health returned status 404", status.message)
    }

    @Test
    fun testCleartextTrafficBlockedSimulation() = runBlocking {
        val health = PyricBridgeHealth(
            httpClient = clientWithException(
                IOException("Cleartext HTTP traffic to 127.0.0.1 not permitted")
            )
        )
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Cleartext Traffic Blocked", status.message)
        assertTrue(status.details?.contains("network_security_config.xml") == true)
    }

    @Test
    fun testSocketTimeoutHandling() = runBlocking {
        val health = PyricBridgeHealth(
            httpClient = clientWithException(SocketTimeoutException("Read timed out"))
        )
        val status = health.checkHealth()

        assertFalse(status.isReachable)
        assertFalse(status.isSandboxConnected)
        assertEquals("Network Error: Read timed out", status.message)
    }
}
