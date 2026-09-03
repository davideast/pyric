package dev.pyric.codecs

import java.util.Base64

object Base64Url {
    fun encodeUnpadded(bytes: ByteArray): String {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    fun decodeUnpadded(input: String): ByteArray {
        var normalized = input.replace('-', '+').replace('_', '/')
        val remainder = normalized.length % 4
        if (remainder != 0) {
            normalized += "=".repeat(4 - remainder)
        }
        return Base64.getDecoder().decode(normalized)
    }

    fun decodeStandard(input: String): ByteArray {
        return Base64.getDecoder().decode(input)
    }
}
