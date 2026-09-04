package dev.pyric.example.todo.data

import com.google.android.gms.tasks.await
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.snapshots
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * Firestore-backed implementation of [TodoRepository] using Pyric's pure-Kotlin SDK.
 */
class FirestoreTodoRepository(
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance()
) : TodoRepository {

    private val collection = firestore.collection(COLLECTION_NAME)

    override fun getTodosStream(userId: String): Flow<List<Todo>> {
        return collection
            .whereEqualTo(FIELD_USER_ID, userId)
            .snapshots()
            .map { snapshot ->
                snapshot.documents
                    .map { doc -> Todo.fromSnapshot(doc) }
                    .sortedWith(
                        compareByDescending<Todo> { it.createdAt?.seconds ?: Long.MAX_VALUE }
                            .thenByDescending { it.id }
                    )
            }
    }

    override suspend fun addTodo(title: String, userId: String) {
        val trimmed = title.trim()
        require(trimmed.isNotEmpty()) { "Todo title cannot be blank" }

        val documentData = mapOf(
            FIELD_TITLE to trimmed,
            FIELD_COMPLETED to false,
            FIELD_USER_ID to userId,
            FIELD_CREATED_AT to FieldValue.serverTimestamp()
        )
        collection.add(documentData).await()
    }

    override suspend fun triggerUnauthorizedWrite() {
        val documentData = mapOf(
            FIELD_TITLE to "Unauthorized Hacker Todo",
            FIELD_COMPLETED to false,
            FIELD_USER_ID to "attacker-wrong-uid-999",
            FIELD_CREATED_AT to FieldValue.serverTimestamp()
        )
        collection.add(documentData).await()
    }

    override suspend fun toggleTodo(id: String, completed: Boolean) {
        require(id.isNotEmpty()) { "Todo ID cannot be empty" }
        collection.document(id).update(FIELD_COMPLETED, !completed).await()
    }

    override suspend fun deleteTodo(id: String) {
        require(id.isNotEmpty()) { "Todo ID cannot be empty" }
        collection.document(id).delete().await()
    }

    override fun isBridgeConnected(): Boolean {
        return firestore.bridgeClient.isConnected
    }

    companion object {
        private const val COLLECTION_NAME = "todos"
        private const val FIELD_TITLE = "title"
        private const val FIELD_COMPLETED = "completed"
        private const val FIELD_USER_ID = "userId"
        private const val FIELD_CREATED_AT = "createdAt"
    }
}
