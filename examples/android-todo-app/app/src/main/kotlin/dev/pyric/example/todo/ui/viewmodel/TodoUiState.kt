package dev.pyric.example.todo.ui.viewmodel

import dev.pyric.example.todo.data.Todo
import dev.pyric.example.todo.data.TodoFilter

/**
 * Immutable UI State representing the complete screen state of the Todo application.
 */
data class TodoUiState(
    val todos: List<Todo> = emptyList(),
    val filteredTodos: List<Todo> = emptyList(),
    val filter: TodoFilter = TodoFilter.ALL,
    val isLoading: Boolean = true,
    val errorMessage: String? = null,
    val isConnected: Boolean = false,
    val currentUserId: String? = null,
    val currentUserEmail: String? = null,
    val activeCount: Int = 0,
    val completedCount: Int = 0
) {
    val totalCount: Int get() = todos.size
    val hasTodos: Boolean get() = todos.isNotEmpty()
    val isFilterEmpty: Boolean get() = filteredTodos.isEmpty()
    val isAuthenticated: Boolean get() = currentUserId != null
}
