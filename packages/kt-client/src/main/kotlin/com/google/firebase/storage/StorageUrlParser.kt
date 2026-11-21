package com.google.firebase.storage

import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

internal data class ParsedStorageLocation(
    val bucket: String,
    val wirePath: String
)

internal object StorageUrlParser {
    private const val GS_SCHEME_PREFIX = "gs://"
    private const val INVALID_GS_BUCKET_URL_MESSAGE =
        "Please use a gs:// URL for your Firebase Storage bucket."
    private const val BUCKET_WITH_PATH_MESSAGE =
        "The storage Uri cannot contain a path element."
    private const val URI_PARSE_MESSAGE =
        "The storage Uri could not be parsed."

    private val BUCKET_PATTERN = Regex("^[A-Za-z0-9._-]+$")
    private val GS_URL_REGEX = Regex("^gs://([A-Za-z0-9._-]+)(?:/(.*))?$", RegexOption.IGNORE_CASE)
    private val FIREBASE_STORAGE_URL_REGEX = Regex(
        "^https?://firebasestorage\\.googleapis\\.com/v[A-Za-z0-9_]+/b/([A-Za-z0-9._-]+)/o(?:/([^?#]*))?(?:[?#].*)?$",
        RegexOption.IGNORE_CASE
    )
    private val GCS_STORAGE_URL_REGEX = Regex(
        "^https?://(?:storage\\.googleapis\\.com|storage\\.cloud\\.google\\.com)/([A-Za-z0-9._-]+)(?:/([^?#]*))?(?:[?#].*)?$",
        RegexOption.IGNORE_CASE
    )
    private val PYRIC_BYTE_ROUTE_URL_REGEX = Regex(
        "^https?://[^/?#]+/__pyric/storage/v0/b/([^/?#]+)/o(?:/([^?#]*))?(?:[?#].*)?$",
        RegexOption.IGNORE_CASE
    )
    private val EMULATOR_STORAGE_URL_REGEX = Regex(
        "^https?://[^/?#]+/v0/b/([A-Za-z0-9._-]+)/o(?:/([^?#]*))?(?:[?#].*)?$",
        RegexOption.IGNORE_CASE
    )

    fun parseGsBucketInstanceUrl(url: String): String {
        val trimmed = url.trim()
        if (!trimmed.lowercase().startsWith(GS_SCHEME_PREFIX)) {
            throw IllegalArgumentException(INVALID_GS_BUCKET_URL_MESSAGE)
        }
        val withoutScheme = trimmed.substring(GS_SCHEME_PREFIX.length)
        val slashIndex = withoutScheme.indexOf('/')
        val bucketPart: String
        val pathPart: String
        if (slashIndex == -1) {
            bucketPart = withoutScheme
            pathPart = ""
        } else {
            bucketPart = withoutScheme.substring(0, slashIndex)
            pathPart = withoutScheme.substring(slashIndex + 1)
        }
        if (bucketPart.isEmpty() || !BUCKET_PATTERN.matches(bucketPart)) {
            throw IllegalArgumentException(URI_PARSE_MESSAGE)
        }
        if (normalizeWirePath(pathPart).isNotEmpty()) {
            throw IllegalArgumentException(BUCKET_WITH_PATH_MESSAGE)
        }
        return bucketPart
    }

    fun parseConfiguredOptionBucket(rawBucket: String): String {
        val trimmed = rawBucket.trim()
        if (trimmed.isEmpty()) return ""
        if (trimmed.lowercase().startsWith(GS_SCHEME_PREFIX)) {
            return parseGsBucketInstanceUrl(trimmed)
        }
        if (trimmed.contains("://")) {
            val parsed = parseFullStorageUrl(trimmed)
            if (parsed.wirePath.isNotEmpty()) {
                throw IllegalArgumentException(BUCKET_WITH_PATH_MESSAGE)
            }
            return parsed.bucket
        }
        val cleaned = trimmed.trimEnd('/')
        if (cleaned.contains('/')) {
            throw IllegalArgumentException(BUCKET_WITH_PATH_MESSAGE)
        }
        return cleaned
    }

    fun parseFullStorageUrl(fullUrl: String): ParsedStorageLocation {
        val trimmed = fullUrl.trim()
        require(trimmed.isNotEmpty()) { "location must not be null or empty" }

        val gsMatch = GS_URL_REGEX.matchEntire(trimmed)
        if (gsMatch != null) {
            val bucket = gsMatch.groupValues[1]
            val rawPath = gsMatch.groupValues[2]
            return ParsedStorageLocation(bucket, normalizeWirePath(rawPath))
        }

        val pyricMatch = PYRIC_BYTE_ROUTE_URL_REGEX.matchEntire(trimmed)
        if (pyricMatch != null) {
            val bucket = percentDecode(pyricMatch.groupValues[1])
            val decodedPath = percentDecode(pyricMatch.groupValues[2])
            if (bucket.isEmpty()) throw IllegalArgumentException(URI_PARSE_MESSAGE)
            return ParsedStorageLocation(bucket, normalizeWirePath(decodedPath))
        }

        val fbMatch = FIREBASE_STORAGE_URL_REGEX.matchEntire(trimmed)
        if (fbMatch != null) {
            val bucket = fbMatch.groupValues[1]
            val decodedPath = percentDecode(fbMatch.groupValues[2])
            return ParsedStorageLocation(bucket, normalizeWirePath(decodedPath))
        }

        val gcsMatch = GCS_STORAGE_URL_REGEX.matchEntire(trimmed)
        if (gcsMatch != null) {
            val bucket = gcsMatch.groupValues[1]
            val decodedPath = percentDecode(gcsMatch.groupValues[2])
            return ParsedStorageLocation(bucket, normalizeWirePath(decodedPath))
        }

        val emulatorMatch = EMULATOR_STORAGE_URL_REGEX.matchEntire(trimmed)
        if (emulatorMatch != null) {
            val bucket = emulatorMatch.groupValues[1]
            val decodedPath = percentDecode(emulatorMatch.groupValues[2])
            return ParsedStorageLocation(bucket, normalizeWirePath(decodedPath))
        }

        throw IllegalArgumentException(URI_PARSE_MESSAGE)
    }

    fun isUrlString(location: String): Boolean {
        val lower = location.trim().lowercase()
        return lower.startsWith("gs://") ||
            lower.startsWith("http://") ||
            lower.startsWith("https://")
    }

    fun normalizeWirePath(rawPath: String): String {
        if (rawPath.isEmpty()) return ""
        return rawPath
            .split('/')
            .filter { it.isNotEmpty() }
            .joinToString("/")
    }

    fun joinWirePaths(parentWirePath: String, childSegment: String): String {
        val normalizedChild = normalizeWirePath(childSegment)
        if (parentWirePath.isEmpty()) return normalizedChild
        if (normalizedChild.isEmpty()) return parentWirePath
        return "$parentWirePath/$normalizedChild"
    }

    fun encodeUriComponent(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
            .replace("+", "%20")
            .replace("%21", "!")
            .replace("%27", "'")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%7E", "~")

    private fun percentDecode(encoded: String): String {
        if (encoded.isEmpty()) return ""
        return try {
            val plusProtected = encoded.replace("+", "%2B")
            URLDecoder.decode(plusProtected, StandardCharsets.UTF_8.name())
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException(URI_PARSE_MESSAGE, e)
        }
    }
}
