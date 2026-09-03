package dev.pyric.codecs

import java.security.SecureRandom

object AutoId {
    private const val AUTO_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
    private const val AUTO_ID_LENGTH = 20
    private val random = SecureRandom()

    fun generate(): String {
        val chars = CharArray(AUTO_ID_LENGTH)
        for (i in 0 until AUTO_ID_LENGTH) {
            chars[i] = AUTO_ID_ALPHABET[random.nextInt(AUTO_ID_ALPHABET.length)]
        }
        return String(chars)
    }
}
