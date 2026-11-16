package com.google.firebase.firestore

class SetOptions private constructor(
    val isMerge: Boolean,
    val mergeFields: List<FieldPath>? = null
) {
    internal fun toWireOptions(): Map<String, Any>? {
        if (mergeFields != null) {
            return mapOf("mergeFields" to mergeFields.map { it.canonicalString })
        }
        if (isMerge) {
            return mapOf("merge" to true)
        }
        return null
    }

    companion object {
        private val OVERWRITE = SetOptions(false)
        private val MERGE_ALL = SetOptions(true)

        @JvmStatic
        fun overwrite(): SetOptions = OVERWRITE

        @JvmStatic
        fun merge(): SetOptions = MERGE_ALL

        @JvmStatic
        fun mergeFields(vararg fields: String): SetOptions =
            SetOptions(true, fields.map { FieldPath.fromDotSeparated(it) })

        @JvmStatic
        fun mergeFields(fields: List<String>): SetOptions =
            SetOptions(true, fields.map { FieldPath.fromDotSeparated(it) })

        @JvmStatic
        fun mergeFieldPaths(fields: List<FieldPath>): SetOptions =
            SetOptions(true, fields)
    }
}
