package com.google.firebase.firestore

class FirebaseFirestoreSettings private constructor(
    val host: String,
    val isSslEnabled: Boolean,
    private val legacyPersistenceEnabled: Boolean,
    private val legacyCacheSizeBytes: Long,
    val cacheSettings: LocalCacheSettings?,
    val grpcFlowControlWindow: Int
) {
    val isPersistenceEnabled: Boolean
        get() {
            if (cacheSettings != null) {
                return cacheSettings is PersistentCacheSettings
            }
            return legacyPersistenceEnabled
        }

    val cacheSizeBytes: Long
        get() {
            val configuredCache = cacheSettings ?: return legacyCacheSizeBytes
            if (configuredCache is PersistentCacheSettings) {
                return configuredCache.sizeBytes
            }
            if (configuredCache is MemoryCacheSettings) {
                val gc = configuredCache.garbageCollectorSettings
                if (gc is MemoryLruGcSettings) {
                    return gc.sizeBytes
                }
                return CACHE_SIZE_UNLIMITED
            }
            return legacyCacheSizeBytes
        }

    class Builder() {
        private var hostField: String = DEFAULT_HOST
        private var sslEnabledField: Boolean = true
        private var persistenceEnabledField: Boolean = true
        private var cacheSizeBytesField: Long = DEFAULT_CACHE_SIZE_BYTES
        private var cacheSettingsField: LocalCacheSettings? = null
        private var grpcFlowControlWindowField: Int = DEFAULT_GRPC_FLOW_CONTROL_WINDOW
        private var usedLegacyCacheSettings: Boolean = false

        var host: String
            get() = hostField
            @JvmSynthetic set(value) {
                setHost(value)
            }

        var isSslEnabled: Boolean
            get() = sslEnabledField
            @JvmSynthetic set(value) {
                setSslEnabled(value)
            }

        var isPersistenceEnabled: Boolean
            get() = persistenceEnabledField
            @JvmSynthetic set(value) {
                setPersistenceEnabled(value)
            }

        var cacheSizeBytes: Long
            get() = cacheSizeBytesField
            @JvmSynthetic set(value) {
                setCacheSizeBytes(value)
            }

        var grpcFlowControlWindow: Int
            get() = grpcFlowControlWindowField
            @JvmSynthetic set(value) {
                setGrpcFlowControlWindow(value)
            }

        constructor(settings: FirebaseFirestoreSettings) : this() {
            this.hostField = settings.host
            this.sslEnabledField = settings.isSslEnabled
            this.persistenceEnabledField = settings.legacyPersistenceEnabled
            this.cacheSizeBytesField = settings.legacyCacheSizeBytes
            this.grpcFlowControlWindowField = settings.grpcFlowControlWindow
            if (!this.persistenceEnabledField || this.cacheSizeBytesField != DEFAULT_CACHE_SIZE_BYTES) {
                this.usedLegacyCacheSettings = true
            }
            if (!this.usedLegacyCacheSettings) {
                this.cacheSettingsField = settings.cacheSettings
            }
        }

        fun setHost(host: String): Builder = apply {
            require(host.isNotBlank()) { "Provided host must not be empty." }
            this.hostField = host
        }

        fun setSslEnabled(sslEnabled: Boolean): Builder = apply {
            this.sslEnabledField = sslEnabled
        }

        fun setPersistenceEnabled(persistenceEnabled: Boolean): Builder = apply {
            check(cacheSettingsField == null) {
                "New cache config API setLocalCacheSettings() is already used."
            }
            this.persistenceEnabledField = persistenceEnabled
            this.usedLegacyCacheSettings = true
        }

        fun setCacheSizeBytes(cacheSizeBytes: Long): Builder = apply {
            check(cacheSettingsField == null) {
                "New cache config API setLocalCacheSettings() is already used."
            }
            require(cacheSizeBytes == CACHE_SIZE_UNLIMITED || cacheSizeBytes >= MINIMUM_CACHE_BYTES) {
                "Cache size must be set to at least $MINIMUM_CACHE_BYTES bytes"
            }
            this.cacheSizeBytesField = cacheSizeBytes
            this.usedLegacyCacheSettings = true
        }

        fun setLocalCacheSettings(settings: LocalCacheSettings): Builder = apply {
            check(!usedLegacyCacheSettings) {
                "Deprecated setPersistenceEnabled() or setCacheSizeBytes() is already used, remove those first."
            }
            require(settings is MemoryCacheSettings || settings is PersistentCacheSettings) {
                "Only MemoryCacheSettings and PersistentCacheSettings are accepted"
            }
            this.cacheSettingsField = settings
        }

        fun setGrpcFlowControlWindow(windowBytes: Int): Builder = apply {
            require(windowBytes >= 0) { "flow control window size must be non-negative" }
            this.grpcFlowControlWindowField = windowBytes
        }

        fun build(): FirebaseFirestoreSettings {
            check(sslEnabledField || hostField != DEFAULT_HOST) {
                "You can't set the 'sslEnabled' setting unless you also set a non-default 'host'."
            }
            return FirebaseFirestoreSettings(
                host = hostField,
                isSslEnabled = sslEnabledField,
                legacyPersistenceEnabled = persistenceEnabledField,
                legacyCacheSizeBytes = cacheSizeBytesField,
                cacheSettings = cacheSettingsField,
                grpcFlowControlWindow = grpcFlowControlWindowField
            )
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FirebaseFirestoreSettings) return false
        return host == other.host &&
            isSslEnabled == other.isSslEnabled &&
            legacyPersistenceEnabled == other.legacyPersistenceEnabled &&
            legacyCacheSizeBytes == other.legacyCacheSizeBytes &&
            grpcFlowControlWindow == other.grpcFlowControlWindow &&
            cacheSettings == other.cacheSettings
    }

    override fun hashCode(): Int {
        var result = host.hashCode()
        result = 31 * result + isSslEnabled.hashCode()
        result = 31 * result + legacyPersistenceEnabled.hashCode()
        result = 31 * result + legacyCacheSizeBytes.hashCode()
        result = 31 * result + grpcFlowControlWindow
        result = 31 * result + (cacheSettings?.hashCode() ?: 0)
        return result
    }

    override fun toString(): String =
        "FirebaseFirestoreSettings{host=$host, sslEnabled=$isSslEnabled, " +
            "persistenceEnabled=$legacyPersistenceEnabled, cacheSizeBytes=$legacyCacheSizeBytes, " +
            "grpcFlowControlWindow=$grpcFlowControlWindow, cacheSettings=$cacheSettings}"

    companion object {
        const val DEFAULT_HOST: String = "firestore.googleapis.com"
        const val CACHE_SIZE_UNLIMITED: Long = -1L
        const val DEFAULT_GRPC_FLOW_CONTROL_WINDOW: Int = 262144
        internal const val DEFAULT_CACHE_SIZE_BYTES: Long = 100L * 1024L * 1024L
        internal const val MINIMUM_CACHE_BYTES: Long = 1L * 1024L * 1024L
    }
}
