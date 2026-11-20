package com.google.firebase.database

sealed class ChildEvent {
    abstract val snapshot: DataSnapshot
    open val previousChildName: String? = null

    data class Added(
        override val snapshot: DataSnapshot,
        override val previousChildName: String? = null
    ) : ChildEvent()

    data class Changed(
        override val snapshot: DataSnapshot,
        override val previousChildName: String? = null
    ) : ChildEvent()

    data class Removed(
        override val snapshot: DataSnapshot
    ) : ChildEvent()

    data class Moved(
        override val snapshot: DataSnapshot,
        override val previousChildName: String? = null
    ) : ChildEvent()
}
