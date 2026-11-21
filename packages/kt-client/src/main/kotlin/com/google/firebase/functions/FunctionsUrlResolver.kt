package com.google.firebase.functions

import java.net.URI
import java.net.URL

internal data class ParsedRegionOrDomain(
    val region: String,
    val customDomain: String?
)

internal data class ResolvedCallableTarget(
    val fetchUrl: String,
    val reportedUrl: String
)

internal object FunctionsUrlResolver {
    const val DEFAULT_REGION: String = "us-central1"
    private const val RUN_SERVICE_QUERY: String = "?__pyric_run_service=1"

    private val CLOUDFUNCTIONS_HOST =
        Regex("^([a-z]+-[a-z]+\\d+)-([a-z0-9-]+)\\.cloudfunctions\\.net$", RegexOption.IGNORE_CASE)
    private val SINGLE_SEGMENT_PATH = Regex("^/([^/]+)/?$")
    private val RUN_APP_LEGACY_HOST =
        Regex("^([a-z0-9-]+)-[a-z0-9]+-[a-z]{2}\\.a\\.run\\.app$", RegexOption.IGNORE_CASE)
    private val RUN_APP_REGIONAL_HOST =
        Regex("^([a-z0-9-]+)-\\d+\\.([a-z]+-[a-z]+\\d+)\\.run\\.app$", RegexOption.IGNORE_CASE)

    fun parseRegionOrCustomDomain(regionOrCustomDomain: String = DEFAULT_REGION): ParsedRegionOrDomain {
        val trimmed = regionOrCustomDomain.trim()
        if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            val uri = runCatching { URI(trimmed) }.getOrNull()
            if (uri != null && uri.scheme != null && uri.authority != null) {
                val rawPath = uri.rawPath.orEmpty()
                val normalizedPath = if (rawPath == "/") "" else rawPath.trimEnd('/')
                return ParsedRegionOrDomain(
                    region = DEFAULT_REGION,
                    customDomain = "${uri.scheme}://${uri.rawAuthority}$normalizedPath"
                )
            }
        }
        return ParsedRegionOrDomain(region = trimmed.ifEmpty { DEFAULT_REGION }, customDomain = null)
    }

    fun resolveDefaultGatewayOrigin(): String? {
        val candidates = listOf(
            System.getProperty("pyric.functions.url"),
            System.getenv("PYRIC_FUNCTIONS_BASE_URL")
        )
        for (candidate in candidates) {
            val cleaned = candidate?.trim()?.trimEnd('/')
            if (!cleaned.isNullOrEmpty()) {
                return cleaned
            }
        }
        val bridgeCandidates = listOf(
            System.getProperty("pyric.bridge.url"),
            System.getenv("PYRIC_LIVE_BRIDGE_URL"),
            System.getenv("PYRIC_BRIDGE_URL")
        )
        for (bridgeRaw in bridgeCandidates) {
            val derived = bridgeUrlToHttpOrigin(bridgeRaw)
            if (derived != null) {
                return derived
            }
        }
        return null
    }

    internal fun bridgeUrlToHttpOrigin(raw: String?): String? {
        val trimmed = raw?.trim()
        if (trimmed.isNullOrEmpty()) return null
        val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
        val scheme = when (uri.scheme?.lowercase()) {
            "ws" -> "http"
            "wss" -> "https"
            "http" -> "http"
            "https" -> "https"
            else -> return null
        }
        val authority = uri.rawAuthority ?: return null
        return "$scheme://$authority"
    }

    fun formatEmulatorOrigin(host: String, port: Int): String {
        val trimmed = host.trim()
        require(trimmed.isNotEmpty()) { "Emulator host must not be empty." }
        require(port in 1..65535) { "Emulator port must be in 1..65535: $port" }
        val formattedHost = if (trimmed.contains(':') && !trimmed.startsWith("[")) {
            "[$trimmed]"
        } else {
            trimmed
        }
        return "http://$formattedHost:$port"
    }

    fun formatLegacyEmulatorOrigin(origin: String): String {
        val trimmed = origin.trim().trimEnd('/')
        require(trimmed.isNotEmpty()) { "Emulator origin must not be empty." }
        return if (trimmed.startsWith("http://", ignoreCase = true) ||
            trimmed.startsWith("https://", ignoreCase = true)
        ) {
            trimmed
        } else {
            "http://$trimmed"
        }
    }

    private fun isLoopbackHost(host: String?): Boolean {
        if (host == null) return false
        val normalized = host.lowercase()
        return normalized == "127.0.0.1" ||
            normalized == "localhost" ||
            normalized == "::1" ||
            normalized == "[::1]"
    }

    private fun isAllowedLocalOrigin(uri: URI, gatewayOrigin: String?): Boolean {
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return false
        }
        if (gatewayOrigin != null) {
            val gwUri = runCatching { URI(gatewayOrigin) }.getOrNull()
            if (gwUri != null &&
                gwUri.scheme.equals(uri.scheme, ignoreCase = true) &&
                gwUri.rawAuthority.equals(uri.rawAuthority, ignoreCase = true)
            ) {
                return true
            }
        }
        return isLoopbackHost(uri.host)
    }

    private fun offMachineException(url: String): FirebaseFunctionsException {
        return FirebaseFunctionsException(
            "Pyric refused off-machine callable URL '$url'; only this project's cloudfunctions.net, run.app, and local gateway URLs are served.",
            FirebaseFunctionsException.Code.UNAVAILABLE,
            null
        )
    }

    fun resolveNamedTarget(
        projectId: String,
        region: String,
        customDomain: String?,
        name: String,
        gatewayOrigin: String?
    ): ResolvedCallableTarget {
        val cleanName = name.trim().trimStart('/')
        require(cleanName.isNotEmpty()) { "Callable function name must not be empty." }

        if (customDomain != null) {
            val reportedUrl = "${customDomain.trimEnd('/')}/$cleanName"
            val parsed = runCatching { URI(reportedUrl) }.getOrNull() ?: throw offMachineException(reportedUrl)
            if (!isAllowedLocalOrigin(parsed, gatewayOrigin)) {
                throw offMachineException(reportedUrl)
            }
            return ResolvedCallableTarget(fetchUrl = reportedUrl, reportedUrl = reportedUrl)
        }

        val reportedUrl = "https://$region-$projectId.cloudfunctions.net/$cleanName"
        if (gatewayOrigin == null || projectId.isEmpty()) {
            throw offMachineException(reportedUrl)
        }
        val base = gatewayOrigin.trimEnd('/')
        val baseUri = runCatching { URI(base) }.getOrNull() ?: throw offMachineException(reportedUrl)
        if (!isAllowedLocalOrigin(baseUri, gatewayOrigin)) {
            throw offMachineException(reportedUrl)
        }
        return ResolvedCallableTarget(
            fetchUrl = "$base/$projectId/$region/$cleanName",
            reportedUrl = reportedUrl
        )
    }

    fun resolveUrlTarget(
        projectId: String,
        region: String,
        url: URL,
        gatewayOrigin: String?
    ): ResolvedCallableTarget {
        val rawUrl = url.toString()
        val parsed = runCatching { url.toURI() }.getOrNull() ?: throw offMachineException(rawUrl)
        if (isAllowedLocalOrigin(parsed, gatewayOrigin)) {
            return ResolvedCallableTarget(fetchUrl = rawUrl, reportedUrl = rawUrl)
        }

        if (!parsed.scheme.equals("https", ignoreCase = true) || gatewayOrigin == null) {
            throw offMachineException(rawUrl)
        }
        val base = gatewayOrigin.trimEnd('/')
        val host = parsed.host ?: throw offMachineException(rawUrl)
        val rawPath = parsed.rawPath.orEmpty()

        val cfMatch = CLOUDFUNCTIONS_HOST.matchEntire(host)
        val pathMatch = SINGLE_SEGMENT_PATH.matchEntire(rawPath)
        if (cfMatch != null && pathMatch != null) {
            val urlRegion = cfMatch.groupValues[1]
            val urlProject = cfMatch.groupValues[2]
            val fnName = pathMatch.groupValues[1]
            if (projectId.isEmpty() || urlProject == projectId) {
                return ResolvedCallableTarget(
                    fetchUrl = "$base/$urlProject/$urlRegion/$fnName",
                    reportedUrl = rawUrl
                )
            }
            throw offMachineException(rawUrl)
        }

        val isRootPath = rawPath.isEmpty() || rawPath == "/"
        if (isRootPath && projectId.isNotEmpty()) {
            val legacyMatch = RUN_APP_LEGACY_HOST.matchEntire(host)
            if (legacyMatch != null) {
                val service = legacyMatch.groupValues[1].lowercase()
                return ResolvedCallableTarget(
                    fetchUrl = "$base/$projectId/$region/$service$RUN_SERVICE_QUERY",
                    reportedUrl = rawUrl
                )
            }
            val regionalMatch = RUN_APP_REGIONAL_HOST.matchEntire(host)
            if (regionalMatch != null) {
                val service = regionalMatch.groupValues[1].lowercase()
                val runRegion = regionalMatch.groupValues[2].lowercase()
                return ResolvedCallableTarget(
                    fetchUrl = "$base/$projectId/$runRegion/$service$RUN_SERVICE_QUERY",
                    reportedUrl = rawUrl
                )
            }
        }

        throw offMachineException(rawUrl)
    }
}
