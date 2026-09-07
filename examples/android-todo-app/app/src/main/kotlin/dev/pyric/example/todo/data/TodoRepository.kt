package dev.pyric.example.todo.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow

enum class DatabaseEngine(val label: String) {
    RTDB("Realtime Database (RTDB)"),
    FIRESTORE("Cloud Firestore")
}

/**
 * Contract for managing Todo data operations across Realtime Database (RTDB) and Cloud Firestore.
 */
interface TodoRepository {
    val activeEngine: StateFlow<DatabaseEngine>
        get() = MutableStateFlow(DatabaseEngine.RTDB)

    fun setEngine(engine: DatabaseEngine) {}

    /**
     * Real-time stream of todos filtered by user ID, ordered by creation time descending.
     */
    fun getTodosStream(userId: String): Flow<List<Todo>> = getTodosStream()

    /**
     * Overload for stream without userId filter.
     */
    fun getTodosStream(): Flow<List<Todo>> = emptyFlow()

    /**
     * Adds a new todo with server-side timestamp for the specified user.
     */
    suspend fun addTodo(title: String, userId: String) = addTodo(title)

    /**
     * Overload for add without userId.
     */
    suspend fun addTodo(title: String) {}

    /**
     * Deliberately attempts an unauthorized write to verify Security Rules enforcement.
     */
    suspend fun triggerUnauthorizedWrite() {}

    /**
     * Toggles the completion state of a todo.
     */
    suspend fun toggleTodo(id: String, completed: Boolean)

    /**
     * Deletes a todo by its document ID.
     */
    suspend fun deleteTodo(id: String)

    /**
     * Returns whether the underlying Pyric bridge client is currently connected.
     */
    fun isBridgeConnected(): Boolean

    /**
     * Reactive stream of bridge connection state.
     */
    fun bridgeConnectionFlow(): Flow<Boolean> = MutableStateFlow(isBridgeConnected())
}
