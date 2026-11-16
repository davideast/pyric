package dev.pyric.codecs

object DocumentDataEnvelope {

    fun unpack(wireData: Any?, resolver: DocumentReferenceResolver? = null): Map<String, Any?> {
        if (wireData == null) return emptyMap()

        if (wireData is String) {
            return try {
                val parsed = JsonCodec.decode(wireData)
                unpack(parsed, resolver)
            } catch (_: Exception) {
                emptyMap()
            }
        }

        if (wireData is Map<*, *>) {
            @Suppress("UNCHECKED_CAST")
            val map = wireData as Map<String, Any?>
            val jsonStr = map["json"] as? String
            if (jsonStr != null) {
                val allowEscapedMaps = map["valueEncoding"] == ValueCodec.DOC_VALUE_ENCODING_V1
                return try {
                    val parsed = JsonCodec.decode(jsonStr)
                    val decoded = ValueCodec.decodeValue(parsed, resolver, allowEscapedMaps)
                    @Suppress("UNCHECKED_CAST")
                    (decoded as? Map<String, Any?>) ?: emptyMap()
                } catch (_: Exception) {
                    emptyMap()
                }
            }
            val decoded = ValueCodec.decodeValue(wireData, resolver)
            @Suppress("UNCHECKED_CAST")
            return (decoded as? Map<String, Any?>) ?: emptyMap()
        }

        return emptyMap()
    }

    fun extractEnvelope(wireData: Any?): Map<String, Any?>? {
        if (wireData !is Map<*, *>) return null
        val jsonStr = wireData["json"] as? String ?: return null
        val encoding = wireData["valueEncoding"] as? String
        return if (encoding != null) {
            mapOf("json" to jsonStr, "valueEncoding" to encoding)
        } else {
            mapOf("json" to jsonStr)
        }
    }
}
