package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import dev.pyric.codecs.AutoId

class CollectionReference internal constructor(
    firestore: FirebaseFirestore,
    path: String
) : Query(firestore, path = path, collectionId = path.substringAfterLast('/')) {

    val id: String get() = collectionId

    val parent: DocumentReference?
        get() = if (path != null && path.contains('/')) {
            firestore.document(path.substringBeforeLast('/'))
        } else null

    fun document(): DocumentReference = document(AutoId.generate())

    fun document(documentPath: String): DocumentReference {
        val trimmed = documentPath.trim('/')
        return firestore.document("$path/$trimmed")
    }

    fun add(data: Any): Task<DocumentReference> {
        val docRef = document()
        return docRef.set(data).continueWith { docRef }
    }
}
