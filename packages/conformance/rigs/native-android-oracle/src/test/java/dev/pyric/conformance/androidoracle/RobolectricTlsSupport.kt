package dev.pyric.conformance.androidoracle

import android.content.Context
import android.net.SSLCertificateSocketFactory
import android.net.SSLSessionCache
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import java.io.File
import java.net.InetAddress
import java.net.Socket
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.SocketFactory
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SNIHostName
import javax.net.ssl.SSLParameters
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.SSLSession
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * Robolectric JVM TLS bridge for `com.google.firebase:firebase-database` (`tubesock.WebSocket`).
 *
 * Upstream Android `tubesock.WebSocket.createSocket()` establishes `wss://` sockets via:
 *   1. `new android.net.SSLSessionCache(File)`
 *   2. `android.net.SSLCertificateSocketFactory.getDefault(60000, cache).createSocket(host, port)`
 *   3. `HttpsURLConnection.getDefaultHostnameVerifier().verify(host, sslSocket.session)`
 *
 * On OpenJDK 21 under Robolectric (where Conscrypt's `AndroidOpenSSL` provider is absent),
 * Android's `SSLCertificateSocketFactory.createSocket` casts OpenJDK's `SSLSocketImpl` to
 * `com.android.org.conscrypt.OpenSSLSocketImpl` (throwing `ClassCastException`), and OpenJDK's
 * `HttpsURLConnection$DefaultHostnameVerifier` unconditionally returns `false`.
 *
 * These shadows route `SSLCertificateSocketFactory.getDefault` through the JVM's standard PKIX
 * `SSLSocketFactory.getDefault()` with HTTPS endpoint identification enabled and install an
 * RFC 2818 / RFC 6125 X.509 certificate hostname verifier on `HttpsURLConnection`.
 */
object RobolectricTlsSupport {
    @Volatile
    private var installed = false

    fun install() {
        if (!installed) {
            HttpsURLConnection.setDefaultHostnameVerifier(Rfc2818HostnameVerifier)
            installed = true
        }
    }
}

@Implements(SSLSessionCache::class)
class RobolectricSslSessionCacheShadow {
    @Implementation
    protected fun __constructor__(dir: File?) {
        // No-op on JVM: OpenJDK manages TLS session resumption internally via SSLSessionContext.
    }

    @Implementation
    protected fun __constructor__(context: Context?) {
        // No-op on JVM.
    }
}

@Implements(SSLCertificateSocketFactory::class)
class RobolectricSslCertificateSocketFactoryShadow {
    companion object {
        @JvmStatic
        @Implementation
        fun getDefault(handshakeTimeoutMillis: Int): SocketFactory {
            return JvmHttpsSocketFactory(handshakeTimeoutMillis)
        }

        @JvmStatic
        @Implementation
        fun getDefault(handshakeTimeoutMillis: Int, cache: SSLSessionCache?): SSLSocketFactory {
            return JvmHttpsSocketFactory(handshakeTimeoutMillis)
        }
    }
}

internal class JvmHttpsSocketFactory(
    private val handshakeTimeoutMillis: Int
) : SSLSocketFactory() {

    private fun delegateFactory(): SSLSocketFactory {
        return SSLSocketFactory.getDefault() as SSLSocketFactory
    }

    private fun configureAndHandshake(rawSocket: Socket, host: String?): SSLSocket {
        val sslSocket = rawSocket as SSLSocket
        val params: SSLParameters = sslSocket.sslParameters
        params.endpointIdentificationAlgorithm = "HTTPS"
        if (!host.isNullOrBlank() && !Rfc2818HostnameVerifier.looksLikeIpLiteral(host)) {
            runCatching {
                params.serverNames = listOf(SNIHostName(host))
            }
        }
        sslSocket.sslParameters = params

        val previousTimeout = sslSocket.soTimeout
        val effectiveHandshakeTimeout = if (handshakeTimeoutMillis > 0) {
            handshakeTimeoutMillis
        } else {
            60_000
        }
        sslSocket.soTimeout = effectiveHandshakeTimeout
        sslSocket.startHandshake()
        sslSocket.soTimeout = previousTimeout
        return sslSocket
    }

    override fun getDefaultCipherSuites(): Array<String> = delegateFactory().defaultCipherSuites

    override fun getSupportedCipherSuites(): Array<String> = delegateFactory().supportedCipherSuites

    override fun createSocket(): Socket = delegateFactory().createSocket()

    override fun createSocket(host: String, port: Int): Socket {
        return configureAndHandshake(delegateFactory().createSocket(host, port), host)
    }

    override fun createSocket(
        host: String,
        port: Int,
        localHost: InetAddress,
        localPort: Int
    ): Socket {
        return configureAndHandshake(
            delegateFactory().createSocket(host, port, localHost, localPort),
            host
        )
    }

    override fun createSocket(host: InetAddress, port: Int): Socket {
        return configureAndHandshake(delegateFactory().createSocket(host, port), host.hostAddress)
    }

    override fun createSocket(
        address: InetAddress,
        port: Int,
        localAddress: InetAddress,
        localPort: Int
    ): Socket {
        return configureAndHandshake(
            delegateFactory().createSocket(address, port, localAddress, localPort),
            address.hostAddress
        )
    }

    override fun createSocket(
        s: Socket,
        host: String,
        port: Int,
        autoClose: Boolean
    ): Socket {
        return configureAndHandshake(
            delegateFactory().createSocket(s, host, port, autoClose),
            host
        )
    }
}

object Rfc2818HostnameVerifier : HostnameVerifier {
    private const val ALT_DNS_NAME = 2
    private const val ALT_IPA_NAME = 7

    override fun verify(hostname: String?, session: SSLSession?): Boolean {
        if (hostname.isNullOrBlank() || session == null || !session.isValid) {
            return false
        }
        val cert = try {
            session.peerCertificates.firstOrNull() as? X509Certificate
        } catch (_: SSLPeerUnverifiedException) {
            null
        } ?: return false

        return verifyCertificate(hostname, cert)
    }

    internal fun verifyCertificate(hostname: String, certificate: X509Certificate): Boolean {
        val trimmed = hostname.trim()
        if (trimmed.isEmpty()) {
            return false
        }
        if (looksLikeIpLiteral(trimmed)) {
            return verifyIpAddress(trimmed, certificate)
        }
        return verifyDnsHostname(trimmed, certificate)
    }

    internal fun looksLikeIpLiteral(host: String): Boolean {
        if (host.contains(':')) {
            return true
        }
        val parts = host.split('.')
        if (parts.size != 4) {
            return false
        }
        return parts.all { part ->
            val num = part.toIntOrNull()
            num != null && num in 0..255
        }
    }

    private fun verifyIpAddress(ipLiteral: String, certificate: X509Certificate): Boolean {
        val targetBytes = runCatching { InetAddress.getByName(ipLiteral).address }.getOrNull()
            ?: return false
        val sanEntries = runCatching { certificate.subjectAlternativeNames }.getOrNull()
            ?: return false
        for (entry in sanEntries) {
            if (entry == null || entry.size < 2) continue
            val type = entry[0] as? Int ?: continue
            val value = entry[1] as? String ?: continue
            if (type == ALT_IPA_NAME) {
                val candidateBytes = runCatching { InetAddress.getByName(value).address }.getOrNull()
                if (candidateBytes != null && candidateBytes.contentEquals(targetBytes)) {
                    return true
                }
            }
        }
        return false
    }

    private fun verifyDnsHostname(hostname: String, certificate: X509Certificate): Boolean {
        val normalizedHost = canonicalizeDns(hostname) ?: return false
        val sanEntries = runCatching { certificate.subjectAlternativeNames }.getOrNull().orEmpty()
        var sawDnsSan = false
        for (entry in sanEntries) {
            if (entry == null || entry.size < 2) continue
            val type = entry[0] as? Int ?: continue
            val pattern = entry[1] as? String ?: continue
            if (type == ALT_DNS_NAME) {
                sawDnsSan = true
                if (matchesDnsPattern(normalizedHost, pattern)) {
                    return true
                }
            }
        }
        if (sawDnsSan) {
            return false
        }
        val commonName = extractSubjectCommonName(certificate.subjectX500Principal.name)
            ?: return false
        return matchesDnsPattern(normalizedHost, commonName)
    }

    internal fun matchesDnsPattern(normalizedHost: String, rawPattern: String): Boolean {
        val host = canonicalizeDns(normalizedHost) ?: return false
        val pattern = canonicalizeDns(rawPattern) ?: return false

        if (!pattern.contains('*')) {
            return host == pattern
        }
        if (!pattern.startsWith("*.") || pattern.indexOf('*', 1) != -1) {
            return false
        }
        val suffix = pattern.substring(1) // ".example.com"
        if (suffix.count { it == '.' } < 2) {
            // Disallow top-level wildcards such as "*.com".
            return false
        }
        if (!host.endsWith(suffix) || host.length <= suffix.length) {
            return false
        }
        val wildcardLabel = host.substring(0, host.length - suffix.length)
        return wildcardLabel.isNotEmpty() && !wildcardLabel.contains('.')
    }

    private fun canonicalizeDns(value: String): String? {
        var cleaned = value.trim().lowercase(Locale.US)
        if (cleaned.endsWith('.')) {
            cleaned = cleaned.dropLast(1)
        }
        if (cleaned.isEmpty() || cleaned.contains(' ')) {
            return null
        }
        return cleaned
    }

    private fun extractSubjectCommonName(rfc2253Dn: String): String? {
        for (rdn in rfc2253Dn.split(',')) {
            val trimmed = rdn.trim()
            if (trimmed.startsWith("CN=", ignoreCase = true)) {
                return trimmed.substring(3).trim()
            }
        }
        return null
    }
}
