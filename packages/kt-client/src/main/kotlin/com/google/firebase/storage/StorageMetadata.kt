package com.google.firebase.storage

import java.util.Collections

/**
 * Metadata for a [StorageReference], holding immutable server snapshot attributes
 * (`bucket`, `generation`, `metadataGeneration`, `name`, `path`, `sizeBytes`,
 * `creationTimeMillis`, `updatedTimeMillis`, `md5Hash`) alongside client-settable
 * HTTP headers and custom metadata key-value pairs.
 */
class StorageMetadata {
    internal class Field<T>(val value: T, val isUserProvided: Boolean) {
        companion object {
            fun <T> defaultValue(value: T): Field<T> = Field(value, false)
            fun <T> userValue(value: T): Field<T> = Field(value, true)
        }
    }

    internal var pathField: String = ""
    internal var bucketField: String? = null
    internal var generationField: String? = null
    internal var metadataGenerationField: String? = null
    internal var creationTimeRaw: String? = null
    internal var updatedTimeRaw: String? = null
    internal var sizeBytesField: Long = 0L
    internal var md5HashField: String? = null
    internal var storageRefField: StorageReference? = null

    internal var contentTypeField: Field<String?> = Field.defaultValue(null)
    internal var cacheControlField: Field<String?> = Field.defaultValue(null)
    internal var contentDispositionField: Field<String?> = Field.defaultValue(null)
    internal var contentEncodingField: Field<String?> = Field.defaultValue(null)
    internal var contentLanguageField: Field<String?> = Field.defaultValue(null)
    internal var customMetadataField: Field<Map<String, String?>> = Field.defaultValue(emptyMap())

    constructor()

    private constructor(original: StorageMetadata, includeServerSnapshot: Boolean) {
        pathField = original.pathField
        bucketField = original.bucketField
        storageRefField = original.storageRefField
        contentTypeField = original.contentTypeField
        cacheControlField = original.cacheControlField
        contentDispositionField = original.contentDispositionField
        contentEncodingField = original.contentEncodingField
        contentLanguageField = original.contentLanguageField
        customMetadataField = Field(
            LinkedHashMap(original.customMetadataField.value),
            original.customMetadataField.isUserProvided
        )
        if (includeServerSnapshot) {
            generationField = original.generationField
            metadataGenerationField = original.metadataGenerationField
            creationTimeRaw = original.creationTimeRaw
            updatedTimeRaw = original.updatedTimeRaw
            sizeBytesField = original.sizeBytesField
            md5HashField = original.md5HashField
        }
    }

    val contentType: String?
        get() = contentTypeField.value

    val cacheControl: String?
        get() = cacheControlField.value

    val contentDisposition: String?
        get() = contentDispositionField.value

    val contentEncoding: String?
        get() = contentEncodingField.value

    val contentLanguage: String?
        get() = contentLanguageField.value

    fun getCustomMetadata(key: String): String? {
        if (key.isEmpty()) return null
        return customMetadataField.value[key]
    }

    val customMetadataKeys: Set<String>
        get() {
            val activeKeys = LinkedHashSet<String>()
            for ((k, v) in customMetadataField.value) {
                if (v != null) {
                    activeKeys.add(k)
                }
            }
            return Collections.unmodifiableSet(activeKeys)
        }

    val path: String
        get() = pathField

    val name: String?
        get() {
            val currentPath = pathField
            if (currentPath.isEmpty()) return null
            val lastSlash = currentPath.lastIndexOf('/')
            return if (lastSlash != -1) currentPath.substring(lastSlash + 1) else currentPath
        }

    val bucket: String?
        get() = bucketField

    val generation: String?
        get() = generationField

    val metadataGeneration: String?
        get() = metadataGenerationField

    val creationTimeMillis: Long
        get() = StorageMetadataWireCodec.parseIsoTimestampMillis(creationTimeRaw)

    val updatedTimeMillis: Long
        get() = StorageMetadataWireCodec.parseIsoTimestampMillis(updatedTimeRaw)

    val sizeBytes: Long
        get() = sizeBytesField

    val md5Hash: String?
        get() = md5HashField

    val reference: StorageReference?
        get() = storageRefField

    internal fun toUploadWireMap(): Map<String, Any?> =
        StorageMetadataWireCodec.toUploadWireMap(this)

    internal fun toSetMetadataPatchWireMap(): Map<String, Any?> =
        StorageMetadataWireCodec.toSetMetadataPatchWireMap(this)

    internal fun mergeOntoExistingForUpload(existing: StorageMetadata): StorageMetadata =
        StorageMetadataWireCodec.mergeOntoExistingForUpload(this, existing)

    class Builder {
        private val target: StorageMetadata
        private var includeServerSnapshot: Boolean = false

        constructor() {
            target = StorageMetadata()
        }

        constructor(original: StorageMetadata) {
            target = StorageMetadata(original, includeServerSnapshot = false)
        }

        var contentType: String?
            get() = target.contentTypeField.value
            set(value) {
                setContentType(value)
            }

        var cacheControl: String?
            get() = target.cacheControlField.value
            set(value) {
                setCacheControl(value)
            }

        var contentDisposition: String?
            get() = target.contentDispositionField.value
            set(value) {
                setContentDisposition(value)
            }

        var contentEncoding: String?
            get() = target.contentEncodingField.value
            set(value) {
                setContentEncoding(value)
            }

        var contentLanguage: String?
            get() = target.contentLanguageField.value
            set(value) {
                setContentLanguage(value)
            }

        fun setContentType(contentType: String?): Builder {
            target.contentTypeField = Field.userValue(contentType)
            return this
        }

        fun setCacheControl(cacheControl: String?): Builder {
            target.cacheControlField = Field.userValue(cacheControl)
            return this
        }

        fun setContentDisposition(contentDisposition: String?): Builder {
            target.contentDispositionField = Field.userValue(contentDisposition)
            return this
        }

        fun setContentEncoding(contentEncoding: String?): Builder {
            target.contentEncodingField = Field.userValue(contentEncoding)
            return this
        }

        fun setContentLanguage(contentLanguage: String?): Builder {
            target.contentLanguageField = Field.userValue(contentLanguage)
            return this
        }

        fun setCustomMetadata(key: String, value: String?): Builder {
            val nextMap = LinkedHashMap(target.customMetadataField.value)
            nextMap[key] = value
            target.customMetadataField = Field.userValue(nextMap)
            return this
        }

        fun build(): StorageMetadata = StorageMetadata(target, includeServerSnapshot)
    }

    companion object {
        internal fun fromWireMap(
            raw: Map<String, Any?>,
            reference: StorageReference? = null
        ): StorageMetadata = StorageMetadataWireCodec.fromWireMap(raw, reference)
    }
}
