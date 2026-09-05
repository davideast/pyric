package dev.pyric.example.todo.data

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot

/**
 * Domain model representing an individual Todo item in the application.
 */
data class Todo(
    val id: String = "",
    val title: String = "",
    val completed: Boolean = false,
    val userId: String = "",
    val createdAt: Timestamp? = null
) {
    companion object {
        /**
         * Maps a Firestore [DocumentSnapshot] into a [Todo] instance.
         * Extracts `id` directly from snapshot metadata and safely extracts field values.
         */
        fun fromSnapshot(snapshot: DocumentSnapshot): Todo {
            return Todo(
                id = snapshot.id,
                title = snapshot.getString("title").orEmpty(),
                completed = snapshot.getBoolean("completed") ?: false,
                userId = snapshot.getString("userId").orEmpty(),
                createdAt = snapshot.getTimestamp("createdAt")
            )
        }
    }
}
