package dev.pyric.example.todo.network

import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.net.ConnectException
import java.util.concurrent.TimeUnit

data class BridgeHealthStatus(
    val isReachable: Boolean,
    val isSandboxConnected: Boolean,
    val message: String,
    val details: String? = null
)

class PyricBridgeHealth(
    private val healthUrl: String = "http://127.0.0.1:5174/__pyric/health",
    private val httpClient: OkHttpClient = defaultClient()
) {
    suspend fun checkHealth(): BridgeHealthStatus = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(healthUrl)
            .header("Host", "127.0.0.1:5174")
            .build()

        try {
            httpClient.newCall(request).execute().use { response ->
                when (response.code) {
                    200 -> {
                        val body = response.body?.string() ?: ""
                        val map = JsonCodec.decodeMap(body)
                        val sandboxConnected = map["sandboxConnected"] == true
                        if (sandboxConnected) {
                            BridgeHealthStatus(
                                isReachable = true,
                                isSandboxConnected = true,
                                message = "Connected to Pyric Sandbox",
                                details = "Instance: ${map["instanceId"]}"
                            )
                        } else {
                            BridgeHealthStatus(
                                isReachable = true,
                                isSandboxConnected = false,
                                message = "Waiting for browser sandbox",
                                details = "Pyric dev server is running, but no browser tab is open. Open http://localhost:5174 in your browser."
                            )
                        }
                    }
                    403 -> BridgeHealthStatus(
                        isReachable = false,
                        isSandboxConnected = false,
                        message = "DNS-Rebinding Guard Rejected Host",
                        details = "Do not connect to 10.0.2.2. Use 127.0.0.1 with: adb reverse tcp:5174 tcp:5174"
                    )
                    else -> BridgeHealthStatus(
                        isReachable = false,
                        isSandboxConnected = false,
                        message = "Bridge health returned status ${response.code}",
                        details = response.message
                    )
                }
            }
        } catch (e: ConnectException) {
            BridgeHealthStatus(
                isReachable = false,
                isSandboxConnected = false,
                message = "Cannot connect to Pyric bridge",
                details = "Ensure Pyric is running and execute: adb reverse tcp:5174 tcp:5174"
            )
        } catch (e: IOException) {
            val msg = e.message ?: "IO Error"
            val isCleartext = msg.contains("Cleartext HTTP traffic", ignoreCase = true)
            BridgeHealthStatus(
                isReachable = false,
                isSandboxConnected = false,
                message = if (isCleartext) "Cleartext Traffic Blocked" else "Network Error: $msg",
                details = if (isCleartext) "Verify network_security_config.xml permits cleartext to 127.0.0.1" else msg
            )
        } catch (e: Exception) {
            BridgeHealthStatus(
                isReachable = false,
                isSandboxConnected = false,
                message = "Unexpected Health Check Failure",
                details = e.message
            )
        }
    }

    companion object {
        private fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(2, TimeUnit.SECONDS)
            .readTimeout(2, TimeUnit.SECONDS)
            .build()
    }
}
