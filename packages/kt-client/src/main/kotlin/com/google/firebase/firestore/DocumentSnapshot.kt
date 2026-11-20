package com.google.firebase.firestore

import com.google.firebase.Timestamp
import dev.pyric.codecs.PojoCodec

open class DocumentSnapshot internal constructor(
    val id: String,
    val reference: DocumentReference,
    private val exists: Boolean,
    private val rawData: Map<String, Any?>?,
    val metadata: SnapshotMetadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false),
    internal val rawWireData: Map<String, Any?>? = null
) {
    open fun exists(): Boolean = exists

    open fun getData(): Map<String, Any?>? = rawData?.let { copyMap(it) }

    internal fun rawMapSnapshot(): Map<String, Any?> = rawData ?: emptyMap()

    fun contains(field: String): Boolean = exists && FieldPath.contains(rawData, field)
    fun contains(fieldPath: FieldPath): Boolean = exists && FieldPath.contains(rawData, fieldPath)

    fun get(field: String): Any? = if (!exists) null else copyValue(FieldPath.extract(rawData, field))
    fun get(fieldPath: FieldPath): Any? = if (!exists) null else copyValue(FieldPath.extract(rawData, fieldPath))
    fun getString(field: String): String? = get(field) as? String
    fun getString(fieldPath: FieldPath): String? = get(fieldPath) as? String
    fun getLong(field: String): Long? = (get(field) as? Number)?.toLong()
    fun getLong(fieldPath: FieldPath): Long? = (get(fieldPath) as? Number)?.toLong()
    fun getDouble(field: String): Double? = (get(field) as? Number)?.toDouble()
    fun getDouble(fieldPath: FieldPath): Double? = (get(fieldPath) as? Number)?.toDouble()
    fun getBoolean(field: String): Boolean? = get(field) as? Boolean
    fun getBoolean(fieldPath: FieldPath): Boolean? = get(fieldPath) as? Boolean
    fun getTimestamp(field: String): Timestamp? = get(field) as? Timestamp
    fun getTimestamp(fieldPath: FieldPath): Timestamp? = get(fieldPath) as? Timestamp
    fun getGeoPoint(field: String): GeoPoint? = get(field) as? GeoPoint
    fun getGeoPoint(fieldPath: FieldPath): GeoPoint? = get(fieldPath) as? GeoPoint
    fun getBlob(field: String): Blob? = get(field) as? Blob
    fun getBlob(fieldPath: FieldPath): Blob? = get(fieldPath) as? Blob
    fun getDocumentReference(field: String): DocumentReference? = get(field) as? DocumentReference
    fun getDocumentReference(fieldPath: FieldPath): DocumentReference? = get(fieldPath) as? DocumentReference

    open fun <T> toObject(valueType: Class<T>): T? =
        if (!exists || rawData == null) null else PojoCodec.deserialize(rawData, valueType, id, reference)

    companion object {
        internal fun copyMap(source: Map<String, Any?>): Map<String, Any?> {
            val out = LinkedHashMap<String, Any?>(source.size)
            for ((k, v) in source) {
                out[k] = copyValue(v)
            }
            return out
        }

        private fun copyValue(value: Any?): Any? {
            if (value is Map<*, *>) {
                val out = LinkedHashMap<String, Any?>(value.size)
                for ((k, v) in value) {
                    out[k.toString()] = copyValue(v)
                }
                return out
            }
            if (value is List<*>) {
                return value.map { copyValue(it) }
            }
            return value
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is DocumentSnapshot) return false
        return id == other.id && reference == other.reference && exists == other.exists && rawData == other.rawData
    }

    override fun hashCode(): Int {
        var result = id.hashCode()
        result = 31 * result + reference.hashCode()
        result = 31 * result + exists.hashCode()
        result = 31 * result + (rawData?.hashCode() ?: 0)
        return result
    }

    override fun toString(): String =
        "DocumentSnapshot(id=$id, path=${reference.path}, exists=$exists, data=$rawData)"
}

val DocumentSnapshot.data: Map<String, Any?>?
    get() = getData()
