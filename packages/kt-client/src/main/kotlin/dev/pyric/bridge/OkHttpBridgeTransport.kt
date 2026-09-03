package dev.pyric.bridge

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

class OkHttpBridgeTransportFactory(
    private val client: OkHttpClient = defaultOkHttpClient()
) : BridgeTransportFactory {

    override fun create(
        url: String,
        headers: Map<String, String>,
        listener: BridgeListener
    ): BridgeTransport {
        val requestBuilder = Request.Builder().url(url)
        headers.forEach { (name, value) ->
            requestBuilder.addHeader(name, value)
        }
        val request = requestBuilder.build()

        val okHttpListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                listener.onOpen()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                listener.onMessage(text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosing(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                listener.onClosed(code, reason)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                listener.onFailure(t)
            }
        }

        val webSocket = client.newWebSocket(request, okHttpListener)
        return OkHttpBridgeTransport(webSocket, listener)
    }

    companion object {
        fun defaultOkHttpClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(30, TimeUnit.SECONDS)
                .build()
        }
    }
}

class OkHttpBridgeTransport(
    private val webSocket: WebSocket,
    private var listener: BridgeListener
) : BridgeTransport {

    override fun send(text: String): Boolean = webSocket.send(text)

    override fun close(code: Int, reason: String?): Boolean {
        return webSocket.close(code, reason)
    }

    override fun setListener(listener: BridgeListener) {
        this.listener = listener
    }
}
