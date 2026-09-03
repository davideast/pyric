package dev.pyric.codecs

enum class Direction(val wireValue: String) {
    ASCENDING("asc"),
    DESCENDING("desc")
}

data class OrderBy(
    val field: String,
    val direction: Direction = Direction.ASCENDING
)

data class Cursor(
    val kind: Kind,
    val values: List<Any?>
) {
    enum class Kind(val wireKind: String) {
        START_AT("startAt"),
        START_AFTER("startAfter"),
        END_BEFORE("endBefore"),
        END_AT("endAt")
    }
}
