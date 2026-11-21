package com.google.firebase.storage

import java.time.Instant

/**
 * Wire serialization, deserialization, and client-lens merge collaborator for [StorageMetadata].
 */
internal object StorageMetadataWireCodec {

    fun toUploadWireMap(source: StorageMetadata): Map<String, Any?> {
        val wire = LinkedHashMap<String, Any?>()
        if (source.contentTypeField.isUserProvided && !source.contentTypeField.value.isNullOrEmpty()) {
            wire["contentType"] = source.contentTypeField.value
        }
        if (source.cacheControlField.isUserProvided && source.cacheControlField.value != null) {
            wire["cacheControl"] = source.cacheControlField.value
        }
        if (source.contentDispositionField.isUserProvided && source.contentDispositionField.value != null) {
            wire["contentDisposition"] = source.contentDispositionField.value
        }
        if (source.contentEncodingField.isUserProvided && source.contentEncodingField.value != null) {
            wire["contentEncoding"] = source.contentEncodingField.value
        }
        if (source.contentLanguageField.isUserProvided && source.contentLanguageField.value != null) {
            wire["contentLanguage"] = source.contentLanguageField.value
        }
        if (source.customMetadataField.isUserProvided) {
            val nonNullCustom = LinkedHashMap<String, String>()
            for ((k, v) in source.customMetadataField.value) {
                if (v != null) {
                    nonNullCustom[k] = v
                }
            }
            wire["customMetadata"] = nonNullCustom
        }
        return wire
    }

    fun toSetMetadataPatchWireMap(source: StorageMetadata): Map<String, Any?> {
        val settable = LinkedHashMap<String, Any?>()
        if (source.contentTypeField.isUserProvided) {
            settable["contentType"] = source.contentTypeField.value?.takeIf { it.isNotEmpty() }
        }
        if (source.cacheControlField.isUserProvided) {
            settable["cacheControl"] = source.cacheControlField.value?.takeIf { it.isNotEmpty() }
        }
        if (source.contentDispositionField.isUserProvided) {
            settable["contentDisposition"] = source.contentDispositionField.value?.takeIf { it.isNotEmpty() }
        }
        if (source.contentEncodingField.isUserProvided) {
            settable["contentEncoding"] = source.contentEncodingField.value?.takeIf { it.isNotEmpty() }
        }
        if (source.contentLanguageField.isUserProvided) {
            settable["contentLanguage"] = source.contentLanguageField.value?.takeIf { it.isNotEmpty() }
        }

        val patch = LinkedHashMap<String, Any?>()
        if (settable.isNotEmpty()) {
            patch["settable"] = settable
        }
        if (source.customMetadataField.isUserProvided) {
            val customPatch = LinkedHashMap<String, String?>()
            for ((k, v) in source.customMetadataField.value) {
                customPatch[k] = v
            }
            patch["customMetadata"] = customPatch
        }
        return patch
    }

    fun mergeOntoExistingForUpload(
        patch: StorageMetadata,
        existing: StorageMetadata
    ): StorageMetadata {
        val merged = StorageMetadata.Builder()
        val nextContentType = if (patch.contentTypeField.isUserProvided) {
            patch.contentTypeField.value?.takeIf { it.isNotEmpty() }
        } else {
            existing.contentType
        }
        if (nextContentType != null) merged.setContentType(nextContentType)

        val nextCacheControl = if (patch.cacheControlField.isUserProvided) {
            patch.cacheControlField.value?.takeIf { it.isNotEmpty() }
        } else {
            existing.cacheControl
        }
        if (nextCacheControl != null) merged.setCacheControl(nextCacheControl)

        val nextDisposition = if (patch.contentDispositionField.isUserProvided) {
            patch.contentDispositionField.value?.takeIf { it.isNotEmpty() }
        } else {
            existing.contentDisposition
        }
        if (nextDisposition != null) merged.setContentDisposition(nextDisposition)

        val nextEncoding = if (patch.contentEncodingField.isUserProvided) {
            patch.contentEncodingField.value?.takeIf { it.isNotEmpty() }
        } else {
            existing.contentEncoding
        }
        if (nextEncoding != null) merged.setContentEncoding(nextEncoding)

        val nextLanguage = if (patch.contentLanguageField.isUserProvided) {
            patch.contentLanguageField.value?.takeIf { it.isNotEmpty() }
        } else {
            existing.contentLanguage
        }
        if (nextLanguage != null) merged.setContentLanguage(nextLanguage)

        val combinedCustom = LinkedHashMap<String, String>()
        for (key in existing.customMetadataKeys) {
            val existingVal = existing.getCustomMetadata(key)
            if (existingVal != null) {
                combinedCustom[key] = existingVal
            }
        }
        if (patch.customMetadataField.isUserProvided) {
            for ((k, v) in patch.customMetadataField.value) {
                if (v == null) {
                    combinedCustom.remove(k)
                } else {
                    combinedCustom[k] = v
                }
            }
        }
        for ((k, v) in combinedCustom) {
            merged.setCustomMetadata(k, v)
        }
        return merged.build()
    }

    fun fromWireMap(
        raw: Map<String, Any?>,
        reference: StorageReference? = null
    ): StorageMetadata {
        val metadata = StorageMetadata()
        metadata.storageRefField = reference
        metadata.pathField = (raw["fullPath"] as? String)
            ?: (raw["path"] as? String)
            ?: (raw["name"] as? String)
            ?: reference?.wirePath
            ?: ""
        metadata.bucketField = (raw["bucket"] as? String)?.takeIf { it.isNotEmpty() }
            ?: reference?.bucket
        metadata.generationField = (raw["generation"] as? String)?.takeIf { it.isNotEmpty() }
        metadata.metadataGenerationField = (
            (raw["metageneration"] as? String)
                ?: (raw["metadataGeneration"] as? String)
            )?.takeIf { it.isNotEmpty() }
        metadata.creationTimeRaw = raw["timeCreated"] as? String
        metadata.updatedTimeRaw = raw["updated"] as? String
        metadata.sizeBytesField = when (val s = raw["size"]) {
            is Number -> s.toLong()
            is String -> s.toLongOrNull() ?: 0L
            else -> 0L
        }
        metadata.md5HashField = (raw["md5Hash"] as? String)?.takeIf { it.isNotEmpty() }

        (raw["contentType"] as? String)?.let {
            metadata.contentTypeField = StorageMetadata.Field.userValue(it)
        }
        (raw["cacheControl"] as? String)?.let {
            metadata.cacheControlField = StorageMetadata.Field.userValue(it)
        }
        (raw["contentDisposition"] as? String)?.let {
            metadata.contentDispositionField = StorageMetadata.Field.userValue(it)
        }
        (raw["contentEncoding"] as? String)?.let {
            metadata.contentEncodingField = StorageMetadata.Field.userValue(it)
        }
        (raw["contentLanguage"] as? String)?.let {
            metadata.contentLanguageField = StorageMetadata.Field.userValue(it)
        }

        @Suppress("UNCHECKED_CAST")
        val customRaw = (raw["customMetadata"] as? Map<String, Any?>)
            ?: (raw["metadata"] as? Map<String, Any?>)
        if (customRaw != null) {
            val parsedCustom = LinkedHashMap<String, String?>()
            for ((k, v) in customRaw) {
                if (v != null) {
                    parsedCustom[k] = v.toString()
                }
            }
            metadata.customMetadataField = StorageMetadata.Field.userValue(parsedCustom)
        }
        return metadata
    }

    fun parseIsoTimestampMillis(raw: String?): Long {
        if (raw.isNullOrBlank()) return 0L
        return try {
            Instant.parse(raw.trim()).toEpochMilli()
        } catch (_: Throwable) {
            raw.trim().toLongOrNull() ?: 0L
        }
    }
}
