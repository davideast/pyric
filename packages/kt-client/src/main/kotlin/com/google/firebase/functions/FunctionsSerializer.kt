package com.google.firebase.functions

internal class FunctionsSerializer {

    fun encode(value: Any?): Any? {
        if (value == null) {
            return null
        }
        if (value is Long) {
            return mapOf(
                "@type" to LONG_TYPE,
                "value" to value.toString()
            )
        }
        if (value is Int || value is Short || value is Byte) {
            return (value as Number).toInt()
        }
        if (value is Double) {
            require(value.isFinite()) { "Object cannot be encoded in JSON: $value" }
            return value
        }
        if (value is Float) {
            require(value.isFinite()) { "Object cannot be encoded in JSON: $value" }
            return value.toDouble()
        }
        if (value is Boolean || value is String) {
            return value
        }
        if (value is Map<*, *>) {
            val encoded = LinkedHashMap<String, Any?>()
            for ((k, v) in value) {
                require(k is String) { "Object keys must be strings." }
                encoded[k] = encode(v)
            }
            return encoded
        }
        if (value is List<*>) {
            return value.map { encode(it) }
        }
        if (value is Array<*>) {
            return value.map { encode(it) }
        }
        if (value is IntArray) {
            return value.map { it }
        }
        if (value is LongArray) {
            return value.map { encode(it) }
        }
        if (value is DoubleArray) {
            return value.map { encode(it) }
        }
        if (value is BooleanArray) {
            return value.map { it }
        }
        throw IllegalArgumentException("Object cannot be encoded in JSON: $value")
    }

    fun decode(raw: Any?): Any? {
        if (raw == null) {
            return null
        }
        if (raw is Number || raw is String || raw is Boolean) {
            return raw
        }
        if (raw is Map<*, *>) {
            if (raw.containsKey("@type")) {
                val typeUrl = raw["@type"] as? String
                val rawVal = raw["value"]?.toString()
                if (typeUrl == LONG_TYPE || typeUrl == UNSIGNED_LONG_TYPE) {
                    if (rawVal == null) {
                        throw IllegalArgumentException("Invalid Long format: null")
                    }
                    return try {
                        if (typeUrl == UNSIGNED_LONG_TYPE) {
                            java.lang.Long.parseUnsignedLong(rawVal)
                        } else {
                            rawVal.toLong()
                        }
                    } catch (e: NumberFormatException) {
                        throw IllegalArgumentException("Invalid Long format:$rawVal", e)
                    }
                }
            }
            val result = LinkedHashMap<String, Any?>()
            for ((k, v) in raw) {
                if (k is String) {
                    result[k] = decode(v)
                }
            }
            return result
        }
        if (raw is List<*>) {
            return raw.map { decode(it) }
        }
        throw IllegalArgumentException("Object cannot be decoded from JSON: $raw")
    }

    companion object {
        const val LONG_TYPE: String = "type.googleapis.com/google.protobuf.Int64Value"
        const val UNSIGNED_LONG_TYPE: String = "type.googleapis.com/google.protobuf.UInt64Value"
    }
}
