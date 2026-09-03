package com.google.firebase.firestore

class FirebaseFirestoreSettings private constructor(
    val host: String,
    val isSslEnabled: Boolean,
    val isPersistenceEnabled: Boolean,
    val cacheSizeBytes: Long
) {
    class Builder {
        private var host: String = "127.0.0.1:5174"
        private var sslEnabled: Boolean = false
        private var persistenceEnabled: Boolean = true
        private var cacheSizeBytes: Long = CACHE_SIZE_UNLIMITED

        fun setHost(host: String): Builder = apply { this.host = host }
        fun setSslEnabled(sslEnabled: Boolean): Builder = apply { this.sslEnabled = sslEnabled }
        fun setPersistenceEnabled(persistenceEnabled: Boolean): Builder = apply { this.persistenceEnabled = persistenceEnabled }
        fun setCacheSizeBytes(cacheSizeBytes: Long): Builder = apply { this.cacheSizeBytes = cacheSizeBytes }

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

    companion object {
        const val CACHE_SIZE_UNLIMITED = -1L
    }
}
