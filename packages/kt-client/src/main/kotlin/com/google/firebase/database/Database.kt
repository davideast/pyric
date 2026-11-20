package com.google.firebase.database

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import kotlinx.coroutines.flow.Flow

/** `Firebase.database`, compiled as `com.google.firebase.database.DatabaseKt.getDatabase`, as in firebase-database. */
val Firebase.database: FirebaseDatabase
    get() = FirebaseDatabase.getInstance()

fun Firebase.database(url: String): FirebaseDatabase =
    FirebaseDatabase.getInstance(url)

fun Firebase.database(app: FirebaseApp): FirebaseDatabase =
    FirebaseDatabase.getInstance(app)

fun Firebase.database(app: FirebaseApp, url: String): FirebaseDatabase =
    FirebaseDatabase.getInstance(app, url)

val Query.snapshots: Flow<DataSnapshot>
    get() = snapshotsFlow()

fun Query.snapshots(): Flow<DataSnapshot> =
    snapshotsFlow()

val Query.childEvents: Flow<ChildEvent>
    get() = childEventsFlow()

fun Query.childEvents(): Flow<ChildEvent> =
    childEventsFlow()

inline fun <reified T> DataSnapshot.getValue(): T? =
    getValue(T::class.java)

inline fun <reified T> MutableData.getValue(): T? =
    getValue(T::class.java)
