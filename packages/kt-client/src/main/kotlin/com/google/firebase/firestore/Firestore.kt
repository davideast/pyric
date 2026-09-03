package com.google.firebase.firestore

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.map

val Firebase.firestore: FirebaseFirestore
    get() = FirebaseFirestore.getInstance()

fun Firebase.firestore(app: FirebaseApp): FirebaseFirestore =
    FirebaseFirestore.getInstance(app)

fun Firebase.firestore(database: String): FirebaseFirestore =
    FirebaseFirestore.getInstance(database)

fun Firebase.firestore(app: FirebaseApp, database: String): FirebaseFirestore =
    FirebaseFirestore.getInstance(app, database)

fun DocumentReference.snapshots(
    metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE
): Flow<DocumentSnapshot> = callbackFlow {
    val registration = addSnapshotListener(metadataChanges) { snapshot, exception ->
        if (exception != null) {
            cancel(message = "Error getting DocumentReference snapshot", cause = exception)
        } else if (snapshot != null) {
            trySendBlocking(snapshot)
        }
    }
    awaitClose { registration.remove() }
}

fun Query.snapshots(
    metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE
): Flow<QuerySnapshot> = callbackFlow {
    val registration = addSnapshotListener(metadataChanges) { snapshot, exception ->
        if (exception != null) {
            cancel(message = "Error getting Query snapshot", cause = exception)
        } else if (snapshot != null) {
            trySendBlocking(snapshot)
        }
    }
    awaitClose { registration.remove() }
}

inline fun <reified T : Any> DocumentReference.dataObjects(
    metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE
): Flow<T?> = snapshots(metadataChanges).map { it.toObject<T>() }

inline fun <reified T : Any> Query.dataObjects(
    metadataChanges: MetadataChanges = MetadataChanges.EXCLUDE
): Flow<List<T>> = snapshots(metadataChanges).map { it.toObjects<T>() }

inline fun <reified T> DocumentSnapshot.toObject(): T? = toObject(T::class.java)

inline fun <reified T : Any> QueryDocumentSnapshot.toObject(): T = toObject(T::class.java)

inline fun <reified T : Any> QuerySnapshot.toObjects(): List<T> = toObjects(T::class.java)

fun firestoreSettings(
    init: FirebaseFirestoreSettings.Builder.() -> Unit
): FirebaseFirestoreSettings {
    val builder = FirebaseFirestoreSettings.Builder()
    builder.init()
    return builder.build()
}
