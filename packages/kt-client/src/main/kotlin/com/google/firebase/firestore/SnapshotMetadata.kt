package com.google.firebase.firestore

class SnapshotMetadata(
    val hasPendingWrites: Boolean = false,
    val isFromCache: Boolean = false
) {
    @JvmName("hasPendingWritesMethod")
    fun hasPendingWrites(): Boolean = hasPendingWrites

    @JvmName("isFromCacheMethod")
    fun isFromCache(): Boolean = isFromCache

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SnapshotMetadata) return false
        return hasPendingWrites == other.hasPendingWrites && isFromCache == other.isFromCache
    }

    override fun hashCode(): Int {
        var result = hasPendingWrites.hashCode()
        result = 31 * result + isFromCache.hashCode()
        return result
    }

    override fun toString(): String =
        "SnapshotMetadata(hasPendingWrites=$hasPendingWrites, isFromCache=$isFromCache)"
}
