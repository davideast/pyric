package com.google.firebase.firestore

class FirebaseFirestoreSettings private constructor(
    val host: String,
    val isSslEnabled: Boolean,
    val isPersistenceEnabled: Boolean,
    val cacheSizeBytes: Long
) {
    class Builder() {
        private var host: String = "127.0.0.1:5174"
        private var sslEnabled: Boolean = false
        private var persistenceEnabled: Boolean = true
        private var cacheSizeBytes: Long = CACHE_SIZE_UNLIMITED

        constructor(settings: FirebaseFirestoreSettings) : this() {
            this.host = settings.host
            this.sslEnabled = settings.isSslEnabled
            this.persistenceEnabled = settings.isPersistenceEnabled
            this.cacheSizeBytes = settings.cacheSizeBytes
        }

        fun setHost(host: String): Builder = apply {
            require(host.isNotBlank()) { "Provided host must not be empty." }
            this.host = host
        }

        fun setSslEnabled(sslEnabled: Boolean): Builder = apply { this.sslEnabled = sslEnabled }

        fun setPersistenceEnabled(persistenceEnabled: Boolean): Builder = apply {
            this.persistenceEnabled = persistenceEnabled
        }

        fun setCacheSizeBytes(cacheSizeBytes: Long): Builder = apply {
            require(cacheSizeBytes == CACHE_SIZE_UNLIMITED || cacheSizeBytes >= MINIMUM_CACHE_BYTES) {
                "Cache size must be set to at least $MINIMUM_CACHE_BYTES bytes"
            }
            this.cacheSizeBytes = cacheSizeBytes
        }

        fun getHost(): String = host
        fun isSslEnabled(): Boolean = sslEnabled
        fun isPersistenceEnabled(): Boolean = persistenceEnabled
        fun getCacheSizeBytes(): Long = cacheSizeBytes

        fun build(): FirebaseFirestoreSettings = FirebaseFirestoreSettings(
            host = host,
            isSslEnabled = sslEnabled,
            isPersistenceEnabled = persistenceEnabled,
            cacheSizeBytes = cacheSizeBytes
        )
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FirebaseFirestoreSettings) return false
        return host == other.host &&
            isSslEnabled == other.isSslEnabled &&
            isPersistenceEnabled == other.isPersistenceEnabled &&
            cacheSizeBytes == other.cacheSizeBytes
    }

    override fun hashCode(): Int {
        var result = host.hashCode()
        result = 31 * result + isSslEnabled.hashCode()
        result = 31 * result + isPersistenceEnabled.hashCode()
        result = 31 * result + cacheSizeBytes.hashCode()
        return result
    }

    override fun toString(): String =
        "FirebaseFirestoreSettings(host=$host, isSslEnabled=$isSslEnabled, " +
            "isPersistenceEnabled=$isPersistenceEnabled, cacheSizeBytes=$cacheSizeBytes)"

    companion object {
        const val CACHE_SIZE_UNLIMITED = -1L
        internal const val MINIMUM_CACHE_BYTES = 1L * 1024L * 1024L
    }
}
