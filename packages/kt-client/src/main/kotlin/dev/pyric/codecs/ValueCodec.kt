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

    const val DOC_VALUE_ENCODING_V1 = "pyric/firestore-values/1"

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

    fun decodeValue(
        value: Any?,
        resolver: DocumentReferenceResolver? = null
    ): Any? = decodeValue(value, resolver, false)

    fun decodeValue(
        value: Any?,
        resolver: DocumentReferenceResolver? = null,
        allowEscapedMaps: Boolean
    ): Any? {
        return when (value) {
            null -> null
            is Boolean, is Number, is String -> value
            is List<*> -> value.map { decodeValue(it, resolver, allowEscapedMaps) }
            is Map<*, *> -> {
                @Suppress("UNCHECKED_CAST")
                val map = value as Map<String, Any?>

                // 1. Primary __type marker
                val typeMarker = map["__type"] as? String
                if (typeMarker != null) {
                    return when (typeMarker) {
                        "timestamp" -> {
                            val seconds = (map["seconds"] as? Number)?.toLong()
                            val nanos = (map["nanos"] as? Number)?.toInt()
                            if (seconds != null && nanos != null) {
                                Timestamp(seconds, nanos)
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "latlng" -> {
                            val lat = (map["lat"] as? Number)?.toDouble()
                            val lng = (map["lng"] as? Number)?.toDouble()
                            if (lat != null && lng != null) {
                                GeoPoint(lat, lng)
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "bytes" -> {
                            val b64 = map["base64"] as? String
                            if (b64 != null) {
                                Blob.fromBytes(Base64Url.decodeUnpadded(b64))
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "reference" -> {
                            val path = map["path"] as? String
                            if (path != null) {
                                resolver?.resolve(path) ?: PyricDocumentReferenceHolder(path)
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "number" -> {
                            if (map.size == 2 && map.containsKey("value")) {
                                when (map["value"]) {
                                    "NaN" -> Double.NaN
                                    "Infinity" -> Double.POSITIVE_INFINITY
                                    "-Infinity" -> Double.NEGATIVE_INFINITY
                                    "-0" -> -0.0
                                    else -> decodeMapEntries(map, resolver, allowEscapedMaps)
                                }
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        else -> decodeMapEntries(map, resolver, allowEscapedMaps)
                    }
                }

                // 2. Escaped user map wrapper under declared pyric/firestore-values/1 encoding
                val compatType = map["type"] as? String
                if (allowEscapedMaps && compatType == "pyric/map/1.0" && map.size == 2) {
                    val rawFields = map["fields"]
                    if (rawFields is Map<*, *>) {
                        @Suppress("UNCHECKED_CAST")
                        return decodeMapEntries(rawFields as Map<String, Any?>, resolver, allowEscapedMaps)
                    }
                }

                // 3. Compatibility type marker
                if (compatType != null) {
                    return when (compatType) {
                        "firestore/timestamp/1.0" -> {
                            val seconds = (map["seconds"] as? Number)?.toLong()
                            val nanos = (map["nanoseconds"] as? Number)?.toInt()
                            if (seconds != null && nanos != null) {
                                Timestamp(seconds, nanos)
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "firestore/geoPoint/1.0" -> {
                            val lat = (map["latitude"] as? Number)?.toDouble()
                            val lng = (map["longitude"] as? Number)?.toDouble()
                            if (lat != null && lng != null) {
                                GeoPoint(lat, lng)
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        "firestore/bytes/1.0" -> {
                            val b64 = map["bytes"] as? String
                            if (b64 != null) {
                                Blob.fromBytes(Base64Url.decodeStandard(b64))
                            } else {
                                decodeMapEntries(map, resolver, allowEscapedMaps)
                            }
                        }
                        else -> decodeMapEntries(map, resolver, allowEscapedMaps)
                    }
                }

                decodeMapEntries(map, resolver, allowEscapedMaps)
            }
            else -> value
        }
    }

    private fun decodeMapEntries(
        map: Map<String, Any?>,
        resolver: DocumentReferenceResolver?,
        allowEscapedMaps: Boolean
    ): Map<String, Any?> {
        val out = mutableMapOf<String, Any?>()
        for ((k, v) in map) {
            out[k] = decodeValue(v, resolver, allowEscapedMaps)
        }
        return out
    }
}
