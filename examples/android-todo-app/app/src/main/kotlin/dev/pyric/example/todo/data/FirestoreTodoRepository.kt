package dev.pyric.example.todo.data

import com.google.android.gms.tasks.await
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.snapshots
import dev.pyric.database.FirebaseDatabase
import dev.pyric.database.ServerValue
import dev.pyric.database.snapshots
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.map

/**
 * Multi-engine implementation of [TodoRepository] supporting both Realtime Database (RTDB)
 * and Cloud Firestore using Pyric's pure-Kotlin SDKs.
 */
class FirestoreTodoRepository(
    private val firestore: FirebaseFirestore = FirebaseFirestore.getInstance(),
    private val database: FirebaseDatabase = FirebaseDatabase.getInstance(
        com.google.firebase.FirebaseApp.getInstance(),
        firestore.bridgeClient
    )
) : TodoRepository {

    private val _activeEngine = MutableStateFlow(DatabaseEngine.RTDB)
    override val activeEngine: StateFlow<DatabaseEngine> = _activeEngine.asStateFlow()

    override fun setEngine(engine: DatabaseEngine) {
        _activeEngine.value = engine
    }

    private val collection = firestore.collection(COLLECTION_NAME)

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun getTodosStream(userId: String): Flow<List<Todo>> {
        return _activeEngine.flatMapLatest { engine ->
            when (engine) {
                DatabaseEngine.RTDB -> {
                    database.getReference(COLLECTION_NAME)
                        .orderByChild(FIELD_USER_ID)
                        .equalTo(userId)
                        .snapshots()
                        .map { snapshot ->
                            snapshot.children
                                .map { childSnap -> Todo.fromRtdbSnapshot(childSnap) }
                                .sortedWith(
                                    compareByDescending<Todo> { it.createdAt?.seconds ?: Long.MAX_VALUE }
                                        .thenByDescending { it.id }
                                )
                        }
                }
                DatabaseEngine.FIRESTORE -> {
                    collection
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
            }
        }
    }

    override suspend fun addTodo(title: String, userId: String) {
        val trimmed = title.trim()
        require(trimmed.isNotEmpty()) { "Todo title cannot be blank" }

        when (_activeEngine.value) {
            DatabaseEngine.RTDB -> {
                val data = mapOf(
                    FIELD_TITLE to trimmed,
                    FIELD_COMPLETED to false,
                    FIELD_USER_ID to userId,
                    FIELD_CREATED_AT to ServerValue.TIMESTAMP
                )
                database.getReference(COLLECTION_NAME).push().setValue(data).await()
            }
            DatabaseEngine.FIRESTORE -> {
                val documentData = mapOf(
                    FIELD_TITLE to trimmed,
                    FIELD_COMPLETED to false,
                    FIELD_USER_ID to userId,
                    FIELD_CREATED_AT to FieldValue.serverTimestamp()
                )
                collection.add(documentData).await()
            }
        }
    }

    override suspend fun triggerUnauthorizedWrite() {
        when (_activeEngine.value) {
            DatabaseEngine.RTDB -> {
                val data = mapOf(
                    FIELD_TITLE to "Unauthorized Hacker Todo (RTDB)",
                    FIELD_COMPLETED to false,
                    FIELD_USER_ID to "attacker-wrong-uid-999",
                    FIELD_CREATED_AT to ServerValue.TIMESTAMP
                )
                database.getReference(COLLECTION_NAME).push().setValue(data).await()
            }
            DatabaseEngine.FIRESTORE -> {
                val documentData = mapOf(
                    FIELD_TITLE to "Unauthorized Hacker Todo",
                    FIELD_COMPLETED to false,
                    FIELD_USER_ID to "attacker-wrong-uid-999",
                    FIELD_CREATED_AT to FieldValue.serverTimestamp()
                )
                collection.add(documentData).await()
            }
        }
    }

    override suspend fun toggleTodo(id: String, completed: Boolean) {
        require(id.isNotEmpty()) { "Todo ID cannot be empty" }
        when (_activeEngine.value) {
            DatabaseEngine.RTDB -> {
                database.getReference("$COLLECTION_NAME/$id")
                    .updateChildren(mapOf(FIELD_COMPLETED to !completed))
                    .await()
            }
            DatabaseEngine.FIRESTORE -> {
                collection.document(id).update(FIELD_COMPLETED, !completed).await()
            }
        }
    }

    override suspend fun deleteTodo(id: String) {
        require(id.isNotEmpty()) { "Todo ID cannot be empty" }
        when (_activeEngine.value) {
            DatabaseEngine.RTDB -> {
                database.getReference("$COLLECTION_NAME/$id").removeValue().await()
            }
            DatabaseEngine.FIRESTORE -> {
                collection.document(id).delete().await()
            }
        }
    }

    override fun isBridgeConnected(): Boolean {
        return database.bridgeClient.isConnected || firestore.bridgeClient.isConnected
    }

    override fun bridgeConnectionFlow(): Flow<Boolean> {
        return kotlinx.coroutines.flow.combine(
            database.bridgeClient.connectionStateFlow,
            firestore.bridgeClient.connectionStateFlow
        ) { dbConn, fsConn -> dbConn || fsConn }
    }

    companion object {
        private const val COLLECTION_NAME = "todos"
        private const val FIELD_TITLE = "title"
        private const val FIELD_COMPLETED = "completed"
        private const val FIELD_USER_ID = "userId"
        private const val FIELD_CREATED_AT = "createdAt"
    }
}
