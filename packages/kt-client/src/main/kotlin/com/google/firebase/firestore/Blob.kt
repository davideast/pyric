package com.google.firebase.firestore

/**
 * Immutable wrapper around a byte array for Firestore blob storage.
 */
class Blob private constructor(private val bytes: ByteArray) : Comparable<Blob> {

    fun toBytes(): ByteArray = bytes.clone()

    override fun compareTo(other: Blob): Int {
        val minLen = minOf(bytes.size, other.bytes.size)
        for (i in 0 until minLen) {
            val b1 = bytes[i].toInt() and 0xFF
            val b2 = other.bytes[i].toInt() and 0xFF
            if (b1 != b2) return b1.compareTo(b2)
        }
        return bytes.size.compareTo(other.bytes.size)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Blob) return false
        return bytes.contentEquals(other.bytes)
    }

    override fun hashCode(): Int = bytes.contentHashCode()

    override fun toString(): String = "Blob(size=${bytes.size})"

    companion object {
        fun fromBytes(bytes: ByteArray): Blob = Blob(bytes.clone())
    }
}
