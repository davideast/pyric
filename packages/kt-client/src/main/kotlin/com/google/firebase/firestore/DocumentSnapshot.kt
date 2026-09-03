package com.google.firebase.firestore

import com.google.firebase.Timestamp
import dev.pyric.codecs.PojoCodec

open class DocumentSnapshot internal constructor(
    val id: String,
    val reference: DocumentReference,
    private val exists: Boolean,
    private val rawData: Map<String, Any?>?,
    val metadata: SnapshotMetadata = SnapshotMetadata(hasPendingWrites = false, isFromCache = false)
) {
    open fun exists(): Boolean = exists

    open fun getData(): Map<String, Any?>? = rawData

    fun get(field: String): Any? = FieldPath.extract(rawData, field)
    fun get(fieldPath: FieldPath): Any? = FieldPath.extract(rawData, fieldPath)
    fun getString(field: String): String? = get(field) as? String
    fun getLong(field: String): Long? = (get(field) as? Number)?.toLong()
    fun getDouble(field: String): Double? = (get(field) as? Number)?.toDouble()
    fun getBoolean(field: String): Boolean? = get(field) as? Boolean
    fun getTimestamp(field: String): Timestamp? = get(field) as? Timestamp
    fun getGeoPoint(field: String): GeoPoint? = get(field) as? GeoPoint
    fun getBlob(field: String): Blob? = get(field) as? Blob
    fun getDocumentReference(field: String): DocumentReference? = get(field) as? DocumentReference

    open fun <T> toObject(valueType: Class<T>): T? =
        if (!exists || rawData == null) null else PojoCodec.deserialize(rawData, valueType)

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
