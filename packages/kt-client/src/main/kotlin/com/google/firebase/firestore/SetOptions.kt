package com.google.firebase.firestore

class SetOptions private constructor(
    val isMerge: Boolean,
    val mergeFields: List<FieldPath>? = null
) {
    companion object {
        private val OVERWRITE = SetOptions(false)
        private val MERGE_ALL = SetOptions(true)

        fun overwrite(): SetOptions = OVERWRITE

        fun merge(): SetOptions = MERGE_ALL

        fun mergeFields(vararg fields: String): SetOptions =
            SetOptions(true, fields.map { FieldPath.fromDotSeparated(it) })

        fun mergeFields(fields: List<String>): SetOptions =
            SetOptions(true, fields.map { FieldPath.fromDotSeparated(it) })

        fun mergeFieldPaths(fields: List<FieldPath>): SetOptions =
            SetOptions(true, fields)
    }
}
