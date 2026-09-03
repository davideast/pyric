package dev.pyric.codecs

import com.google.firebase.Timestamp
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.GeoPoint
import java.util.Date

fun interface DocumentReferenceResolver {
    fun resolve(path: String): Any
}

data class PyricDocumentReferenceHolder(val path: String)

object ValueCodec {

    fun encodeValue(value: Any?): Any? {
        return when (value) {
            null -> null
            is Boolean, is Number, is String -> value
            is Timestamp -> mapOf(
                "__type" to "timestamp",
                "seconds" to value.seconds,
                "nanos" to value.nanoseconds
            )
            is Date -> {
                val ts = Timestamp(value)
                mapOf(
                    "__type" to "timestamp",
                    "seconds" to ts.seconds,
                    "nanos" to ts.nanoseconds
                )
            }
            is GeoPoint -> mapOf(
                "__type" to "latlng",
                "lat" to value.latitude,
                "lng" to value.longitude
            )
            is Blob -> mapOf(
                "__type" to "bytes",
                "base64" to Base64Url.encodeUnpadded(value.toBytes())
            )
            is ByteArray -> mapOf(
                "__type" to "bytes",
                "base64" to Base64Url.encodeUnpadded(value)
            )
            is DocumentReference -> mapOf(
                "__type" to "reference",
                "path" to value.path
            )
            is PyricDocumentReferenceHolder -> mapOf(
                "__type" to "reference",
                "path" to value.path
            )
            is FieldValue.ServerTimestampSentinel -> mapOf(
                "__sentinel" to "serverTimestamp"
            )
            is FieldValue.DeleteSentinel -> mapOf(
                "__sentinel" to "deleteField"
            )
            is FieldValue.IncrementSentinel -> mapOf(
                "__sentinel" to "increment",
                "n" to value.operand
            )
            is FieldValue.ArrayUnionSentinel -> {
                SentinelValidator.validateNoArraySentinels(value.elements, "arrayUnion")
                mapOf(
                    "__sentinel" to "arrayUnion",
                    "values" to value.elements.map { encodeValue(it) }
                )
            }
            is FieldValue.ArrayRemoveSentinel -> {
                SentinelValidator.validateNoArraySentinels(value.elements, "arrayRemove")
                mapOf(
                    "__sentinel" to "arrayRemove",
                    "values" to value.elements.map { encodeValue(it) }
                )
            }
            is List<*> -> value.map { encodeValue(it) }
            is Array<*> -> value.map { encodeValue(it) }
            is Map<*, *> -> {
                val out = mutableMapOf<String, Any?>()
                for ((k, v) in value) {
                    out[k.toString()] = encodeValue(v)
                }
                out
            }
            else -> throw IllegalArgumentException(
                "Cannot serialize ${value::class.qualifiedName} for Pyric bridge wire."
            )
        }
    }

    @Suppress("UNCHECKED_CAST")
    fun encodeWriteData(data: Map<String, Any?>): Map<String, Any?> {
        return (encodeValue(data) as? Map<String, Any?>) ?: emptyMap()
    }

    fun decodeValue(value: Any?, resolver: DocumentReferenceResolver? = null): Any? {
        return when (value) {
            null -> null
            is Boolean, is Number, is String -> value
            is List<*> -> value.map { decodeValue(it, resolver) }
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                val map = value as Map<String, Any?>

                // 1. Primary __type marker
                val typeMarker = map["__type"] as? String
                if (typeMarker != null) {
                    return when (typeMarker) {
                        "timestamp" -> {
                            val seconds = (map["seconds"] as Number).toLong()
                            val nanos = (map["nanos"] as Number).toInt()
                            Timestamp(seconds, nanos)
                        }
                        "latlng" -> {
                            val lat = (map["lat"] as Number).toDouble()
                            val lng = (map["lng"] as Number).toDouble()
                            GeoPoint(lat, lng)
                        }
                        "bytes" -> {
                            val b64 = map["base64"] as String
                            Blob.fromBytes(Base64Url.decodeUnpadded(b64))
                        }
                        "reference" -> {
                            val path = map["path"] as String
                            resolver?.resolve(path) ?: PyricDocumentReferenceHolder(path)
                        }
                        else -> decodeMapEntries(map, resolver)
                    }
                }

                // 2. Compatibility type marker
                val compatType = map["type"] as? String
                if (compatType != null) {
                    return when (compatType) {
                        "firestore/timestamp/1.0" -> {
                            val seconds = (map["seconds"] as Number).toLong()
                            val nanos = (map["nanoseconds"] as Number).toInt()
                            Timestamp(seconds, nanos)
                        }
                        "firestore/geoPoint/1.0" -> {
                            val lat = (map["latitude"] as Number).toDouble()
                            val lng = (map["longitude"] as Number).toDouble()
                            GeoPoint(lat, lng)
                        }
                        "firestore/bytes/1.0" -> {
                            val b64 = map["bytes"] as String
                            Blob.fromBytes(Base64Url.decodeStandard(b64))
                        }
                        else -> decodeMapEntries(map, resolver)
                    }
                }

                decodeMapEntries(map, resolver)
            }
            else -> value
        }
    }

    private fun decodeMapEntries(
        map: Map<String, Any?>,
        resolver: DocumentReferenceResolver?
    ): Map<String, Any?> {
        val out = mutableMapOf<String, Any?>()
        for ((k, v) in map) {
            out[k] = decodeValue(v, resolver)
        }
        return out
    }
}
