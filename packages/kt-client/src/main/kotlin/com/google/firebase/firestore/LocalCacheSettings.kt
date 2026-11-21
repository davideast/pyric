package com.google.firebase.firestore

interface LocalCacheSettings

interface MemoryGarbageCollectorSettings

class MemoryEagerGcSettings private constructor() : MemoryGarbageCollectorSettings {
    class Builder internal constructor() {
        fun build(): MemoryEagerGcSettings = MemoryEagerGcSettings()
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        return other != null && javaClass == other.javaClass
    }

    override fun hashCode(): Int = javaClass.hashCode()

    override fun toString(): String = "MemoryEagerGcSettings{}"

    companion object {
        @JvmStatic
        fun newBuilder(): Builder = Builder()
    }
}

class MemoryLruGcSettings private constructor(
    val sizeBytes: Long
) : MemoryGarbageCollectorSettings {
    class Builder internal constructor() {
        private var sizeBytes: Long = FirebaseFirestoreSettings.DEFAULT_CACHE_SIZE_BYTES

        fun setSizeBytes(sizeBytes: Long): Builder = apply {
            require(
                sizeBytes == FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED ||
                    sizeBytes >= FirebaseFirestoreSettings.MINIMUM_CACHE_BYTES
            ) {
                "Cache size must be set to at least ${FirebaseFirestoreSettings.MINIMUM_CACHE_BYTES} bytes"
            }
            this.sizeBytes = sizeBytes
        }

        fun build(): MemoryLruGcSettings = MemoryLruGcSettings(sizeBytes)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || javaClass != other.javaClass) return false
        other as MemoryLruGcSettings
        return sizeBytes == other.sizeBytes
    }

    override fun hashCode(): Int = sizeBytes.hashCode()

    override fun toString(): String = "MemoryLruGcSettings{sizeBytes=$sizeBytes}"

    companion object {
        @JvmStatic
        fun newBuilder(): Builder = Builder()
    }
}

class MemoryCacheSettings private constructor(
    val garbageCollectorSettings: MemoryGarbageCollectorSettings
) : LocalCacheSettings {
    class Builder internal constructor() {
        private var gcSettings: MemoryGarbageCollectorSettings =
            MemoryEagerGcSettings.newBuilder().build()

        fun setGcSettings(gcSettings: MemoryGarbageCollectorSettings): Builder = apply {
            this.gcSettings = gcSettings
        }

        fun build(): MemoryCacheSettings = MemoryCacheSettings(gcSettings)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || javaClass != other.javaClass) return false
        other as MemoryCacheSettings
        return garbageCollectorSettings == other.garbageCollectorSettings
    }

    override fun hashCode(): Int = garbageCollectorSettings.hashCode()

    override fun toString(): String =
        "MemoryCacheSettings{gcSettings=$garbageCollectorSettings}"

    companion object {
        @JvmStatic
        fun newBuilder(): Builder = Builder()
    }
}

class PersistentCacheSettings private constructor(
    val sizeBytes: Long
) : LocalCacheSettings {
    class Builder internal constructor() {
        private var sizeBytes: Long = FirebaseFirestoreSettings.DEFAULT_CACHE_SIZE_BYTES

        fun setSizeBytes(sizeBytes: Long): Builder = apply {
            require(
                sizeBytes == FirebaseFirestoreSettings.CACHE_SIZE_UNLIMITED ||
                    sizeBytes >= FirebaseFirestoreSettings.MINIMUM_CACHE_BYTES
            ) {
                "Cache size must be set to at least ${FirebaseFirestoreSettings.MINIMUM_CACHE_BYTES} bytes"
            }
            this.sizeBytes = sizeBytes
        }

        fun build(): PersistentCacheSettings = PersistentCacheSettings(sizeBytes)
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other == null || javaClass != other.javaClass) return false
        other as PersistentCacheSettings
        return sizeBytes == other.sizeBytes
    }

    override fun hashCode(): Int = sizeBytes.hashCode()

    override fun toString(): String = "PersistentCacheSettings{sizeBytes=$sizeBytes}"

    companion object {
        @JvmStatic
        fun newBuilder(): Builder = Builder()
    }
}
