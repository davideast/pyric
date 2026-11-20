package dev.pyric.database

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

typealias RtdbQuerySpec = com.google.firebase.database.RtdbQuerySpec
typealias ValueEventListener = com.google.firebase.database.ValueEventListener
typealias ChildEventListener = com.google.firebase.database.ChildEventListener
typealias Query = com.google.firebase.database.Query

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

fun Query.snapshots(): Flow<DataSnapshot> = snapshotsFlow()

fun Query.childEvents(): Flow<ChildEvent> = childEventsFlow().map { event ->
    when (event) {
        is com.google.firebase.database.ChildEvent.Added ->
            ChildEvent.Added(event.snapshot, event.previousChildName)
        is com.google.firebase.database.ChildEvent.Changed ->
            ChildEvent.Changed(event.snapshot, event.previousChildName)
        is com.google.firebase.database.ChildEvent.Removed ->
            ChildEvent.Removed(event.snapshot)
        is com.google.firebase.database.ChildEvent.Moved ->
            ChildEvent.Moved(event.snapshot, event.previousChildName)
    }
}
