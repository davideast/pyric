package dev.pyric.codecs

import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldPath

enum class Direction(val wireValue: String) {
    ASCENDING("asc"),
    DESCENDING("desc")
}

data class OrderBy(
    val field: String,
    val direction: Direction = Direction.ASCENDING,
    val fieldPath: FieldPath = FieldPath.fromDotSeparated(field)
)

data class Cursor(
    val kind: Kind,
    val values: List<Any?>,
    val snapshot: DocumentSnapshot? = null
) {
    val isFromSnapshot: Boolean
        get() = snapshot != null

    enum class Kind(val wireKind: String) {
        START_AT("startAt"),
        START_AFTER("startAfter"),
        END_BEFORE("endBefore"),
        END_AT("endAt")
    }
}
