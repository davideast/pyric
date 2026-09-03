package com.google.firebase.firestore

/**
 * A FieldPath refers to a field in a document. The path may consist of a single field name
 * (referring to a top-level field) or a list of field names (referring to a nested field).
 */
class FieldPath private constructor(val segments: List<String>) {

    init {
        require(segments.isNotEmpty()) { "Invalid field path. Path must not be empty." }
        for (segment in segments) {
            require(segment.isNotEmpty()) { "Invalid field name: must not be empty" }
        }
    }

    val canonicalString: String get() = segments.joinToString(".")

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is FieldPath) return false
        return segments == other.segments
    }

    override fun hashCode(): Int = segments.hashCode()

    override fun toString(): String = canonicalString

    companion object {
        private val DOCUMENT_ID_INSTANCE = FieldPath(listOf("__name__"))

        fun of(vararg fieldNames: String): FieldPath {
            require(fieldNames.isNotEmpty()) { "Invalid field path. Path must not be empty." }
            return FieldPath(fieldNames.toList())
        }

        fun fromDotSeparated(path: String): FieldPath {
            require(path.isNotEmpty()) { "Invalid field path. Path must not be empty." }
            return FieldPath(path.split("."))
        }

        fun documentId(): FieldPath = DOCUMENT_ID_INSTANCE

        fun extract(data: Map<String, Any?>?, path: String): Any? {
            if (data == null) return null
            if (data.containsKey(path)) return data[path]
            val segments = path.split(".")
            return extractBySegments(data, segments)
        }

        fun extract(data: Map<String, Any?>?, fieldPath: FieldPath): Any? {
            if (data == null) return null
            return extractBySegments(data, fieldPath.segments)
        }

        private fun extractBySegments(data: Map<String, Any?>?, segments: List<String>): Any? {
            var current: Any? = data
            for (segment in segments) {
                if (current !is Map<*, *>) return null
                current = current[segment]
            }
            return current
        }
    }
}
