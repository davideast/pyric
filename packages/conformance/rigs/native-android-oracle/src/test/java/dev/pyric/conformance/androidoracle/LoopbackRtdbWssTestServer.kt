package dev.pyric.conformance.androidoracle

import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManagerFactory

/**
 * Ephemeral loopback `wss://localhost:<port>` server speaking the Firebase Realtime Database v5
 * WebSocket wire framing so `AndroidOracleProbeRunnerTest` exercises the real `tubesock.WebSocket`
 * `wss://` TLS + `SSLCertificateSocketFactory` + `Rfc2818HostnameVerifier` code path locally.
 */
internal class LoopbackRtdbWssTestServer private constructor(
    private val serverSocket: SSLServerSocket,
    val clientSslContext: SSLContext
) : AutoCloseable {

    val port: Int = serverSocket.localPort
    private val executor: ExecutorService = Executors.newCachedThreadPool()
    private val store = ConcurrentHashMap<String, Any?>()

    @Volatile
    private var running = true

    fun start() {
        executor.submit {
            while (running) {
                val raw = try {
                    serverSocket.accept()
                } catch (_: Exception) {
                    break
                }
                val socket = raw as SSLSocket
                executor.submit { handleClient(socket) }
            }
        }
    }

    private fun handleClient(socket: SSLSocket) {
        socket.use { tls ->
            tls.startHandshake()
            val input = BufferedInputStream(tls.inputStream)
            val output = BufferedOutputStream(tls.outputStream)
            val secKey = readHttpUpgradeKey(input) ?: return
            val acceptHash = MessageDigest.getInstance("SHA-1").digest(
                (secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray(StandardCharsets.US_ASCII)
            )
            val acceptValue = Base64.getEncoder().encodeToString(acceptHash)
            val responseHeaders = buildString {
                append("HTTP/1.1 101 Switching Protocols\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Accept: ").append(acceptValue).append("\r\n\r\n")
            }
            output.write(responseHeaders.toByteArray(StandardCharsets.US_ASCII))
            output.flush()

            val helloFrame = JSONObject()
                .put("t", "c")
                .put(
                    "d",
                    JSONObject()
                        .put("t", "h")
                        .put(
                            "d",
                            JSONObject()
                                .put("ts", 1_700_000_000_000L)
                                .put("v", "5")
                                .put("h", "localhost:$port")
                                .put("s", "sess-loopback-1")
                        )
                )
            writeWsTextFrame(output, helloFrame.toString())

            val dataIn = DataInputStream(input)
            while (running) {
                val text = readWsTextFrame(dataIn) ?: break
                if (text.all { it.isDigit() }) {
                    continue
                }
                val envelope = JSONObject(text)
                if (envelope.optString("t") != "d") {
                    continue
                }
                val d = envelope.getJSONObject("d")
                val reqNum = d.optLong("r", -1L)
                val action = d.optString("a", "")
                val body = d.optJSONObject("b") ?: JSONObject()

                when (action) {
                    "s" -> {
                        replyOk(output, reqNum, JSONObject())
                    }
                    "auth", "gauth", "unauth" -> {
                        replyOk(output, reqNum, JSONObject().put("auth", JSONObject()))
                    }
                    "p" -> {
                        val path = normalizePath(body.optString("p", ""))
                        val value = body.opt("d")
                        if (value == null || value === JSONObject.NULL) {
                            store.remove(path)
                        } else {
                            store[path] = value
                        }
                        replyOk(output, reqNum, "")
                    }
                    "g" -> {
                        val path = normalizePath(body.optString("p", ""))
                        val stored = store[path] ?: JSONObject.NULL
                        replyOk(output, reqNum, stored)
                    }
                    else -> {
                        if (reqNum >= 0L) {
                            replyOk(output, reqNum, "")
                        }
                    }
                }
            }
        }
    }

    private fun normalizePath(rawPath: String): String {
        val trimmed = rawPath.trim('/')
        return "/$trimmed"
    }

    private fun replyOk(output: OutputStream, reqNum: Long, data: Any) {
        val frame = JSONObject()
            .put("t", "d")
            .put(
                "d",
                JSONObject()
                    .put("r", reqNum)
                    .put("b", JSONObject().put("s", "ok").put("d", data))
            )
        writeWsTextFrame(output, frame.toString())
    }

    private fun readHttpUpgradeKey(input: InputStream): String? {
        val headerBytes = ByteArrayOutputStream()
        var state = 0
        while (true) {
            val b = input.read()
            if (b == -1) return null
            headerBytes.write(b)
            state = when {
                state == 0 && b == '\r'.code -> 1
                state == 1 && b == '\n'.code -> 2
                state == 2 && b == '\r'.code -> 3
                state == 3 && b == '\n'.code -> 4
                b == '\r'.code -> 1
                else -> 0
            }
            if (state == 4) break
        }
        val headers = headerBytes.toString(StandardCharsets.US_ASCII)
        for (line in headers.split("\r\n")) {
            if (line.startsWith("Sec-WebSocket-Key:", ignoreCase = true)) {
                return line.substringAfter(':').trim()
            }
        }
        return null
    }

    private fun readWsTextFrame(input: DataInputStream): String? {
        val b0 = try {
            input.readUnsignedByte()
        } catch (_: EOFException) {
            return null
        }
        val opcode = b0 and 0x0F
        if (opcode == 0x08) {
            return null
        }
        val b1 = input.readUnsignedByte()
        val masked = (b1 and 0x80) != 0
        var length = (b1 and 0x7F).toLong()
        if (length == 126L) {
            length = input.readUnsignedShort().toLong()
        } else if (length == 127L) {
            length = input.readLong()
        }
        val maskKey = ByteArray(4)
        if (masked) {
            input.readFully(maskKey)
        }
        val payload = ByteArray(length.toInt())
        input.readFully(payload)
        if (masked) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
            }
        }
        return String(payload, StandardCharsets.UTF_8)
    }

    private fun writeWsTextFrame(output: OutputStream, text: String) {
        val bytes = text.toByteArray(StandardCharsets.UTF_8)
        synchronized(output) {
            output.write(0x81)
            if (bytes.size < 126) {
                output.write(bytes.size)
            } else if (bytes.size <= 65535) {
                output.write(126)
                output.write((bytes.size ushr 8) and 0xFF)
                output.write(bytes.size and 0xFF)
            } else {
                output.write(127)
                val len = bytes.size.toLong()
                for (shift in 56 downTo 0 step 8) {
                    output.write(((len ushr shift) and 0xFFL).toInt())
                }
            }
            output.write(bytes)
            output.flush()
        }
    }

    override fun close() {
        running = false
        runCatching { serverSocket.close() }
        executor.shutdownNow()
    }

    companion object {
        fun open(): LoopbackRtdbWssTestServer {
            val keystoreDir = File(
                System.getProperty("user.home"),
                ".cache/pyric-android-oracle/wss-keystores"
            )
            keystoreDir.mkdirs()
            val keystoreFile = File(keystoreDir, "loopback-${UUID.randomUUID()}.p12")
            val passwordChars = "changeit".toCharArray()
            val javaHome = System.getProperty("java.home")
            val keytoolBin = File(javaHome, "bin/keytool").absolutePath

            val keyStore = KeyStore.getInstance("PKCS12")
            try {
                val genProc = ProcessBuilder(
                    keytoolBin,
                    "-genkeypair",
                    "-alias",
                    "loopback",
                    "-keyalg",
                    "EC",
                    "-groupname",
                    "secp256r1",
                    "-sigalg",
                    "SHA256withECDSA",
                    "-dname",
                    "CN=localhost",
                    "-ext",
                    "SAN=dns:localhost,ip:127.0.0.1",
                    "-validity",
                    "1",
                    "-keystore",
                    keystoreFile.absolutePath,
                    "-storetype",
                    "PKCS12",
                    "-storepass",
                    "changeit"
                ).redirectErrorStream(true).start()
                val genOut = genProc.inputStream.bufferedReader().readText()
                val exitCode = genProc.waitFor()
                check(exitCode == 0) { "keytool failed ($exitCode): $genOut" }

                keystoreFile.inputStream().use { stream ->
                    keyStore.load(stream, passwordChars)
                }
            } finally {
                Files.deleteIfExists(keystoreFile.toPath())
            }

            val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            kmf.init(keyStore, passwordChars)

            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
            tmf.init(keyStore)

            val serverSslContext = SSLContext.getInstance("TLS")
            serverSslContext.init(kmf.keyManagers, null, SecureRandom())

            val clientSslContext = SSLContext.getInstance("TLS")
            clientSslContext.init(null, tmf.trustManagers, SecureRandom())

            val serverSocket = serverSslContext.serverSocketFactory.createServerSocket(
                0,
                8,
                InetAddress.getByName("127.0.0.1")
            ) as SSLServerSocket

            val server = LoopbackRtdbWssTestServer(serverSocket, clientSslContext)
            server.start()
            return server
        }
    }
}
