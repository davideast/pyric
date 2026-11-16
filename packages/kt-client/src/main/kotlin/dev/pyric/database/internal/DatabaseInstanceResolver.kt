package dev.pyric.database.internal

import dev.pyric.database.FirebaseDatabase
import java.net.URI
import java.net.URLDecoder

internal object DatabaseInstanceResolver {
    private val BARE_INSTANCE_NAME = Regex("^[A-Za-z0-9][A-Za-z0-9-]*$")
    private val IPV4_HOST = Regex("^\\d+\\.\\d+\\.\\d+\\.\\d+$")

    fun resolveInstanceName(url: String?, projectId: String? = null): String? {
        if (url == null) return null
        val trimmed = url.trim()
        if (trimmed.isEmpty() || trimmed == FirebaseDatabase.DEFAULT_DATABASE_URL) {
            return null
        }

        val rawName: String? = if (BARE_INSTANCE_NAME.matches(trimmed)) {
            trimmed.lowercase()
        } else {
            val normalized = if (trimmed.contains("://")) trimmed else "https://$trimmed"
            val uri = try {
                URI(normalized)
            } catch (_: Throwable) {
                null
            } ?: return null

            val ns = extractQueryParam(uri.rawQuery, "ns")
            if (!ns.isNullOrBlank()) {
                ns.trim().lowercase()
            } else {
                val host = uri.host?.lowercase() ?: return null
                if (host.isEmpty() || host == "localhost" || IPV4_HOST.matches(host)) {
                    return null
                }
                val labels = host.split('.')
                if (labels.size > 2 && labels[0].isNotEmpty()) labels[0] else null
            }
        }

        if (rawName.isNullOrEmpty() || rawName == "default") return null
        if (!BARE_INSTANCE_NAME.matches(rawName)) return null

        val cleanProjectId = projectId?.trim()?.lowercase()
        if (!cleanProjectId.isNullOrEmpty()) {
            if (rawName == cleanProjectId || rawName == "$cleanProjectId-default-rtdb") {
                return null
            }
        }

        return rawName
    }

    private fun extractQueryParam(rawQuery: String?, key: String): String? {
        if (rawQuery.isNullOrEmpty()) return null
        for (segment in rawQuery.split('&')) {
            if (segment.isEmpty()) continue
            val idx = segment.indexOf('=')
            if (idx <= 0) continue
            val k = decodeComponent(segment.substring(0, idx))
            if (k == key) {
                return decodeComponent(segment.substring(idx + 1))
            }
        }
        return null
    }

    private fun decodeComponent(value: String): String {
        return try {
            URLDecoder.decode(value, "UTF-8")
        } catch (_: Throwable) {
            value
        }
    }
}
