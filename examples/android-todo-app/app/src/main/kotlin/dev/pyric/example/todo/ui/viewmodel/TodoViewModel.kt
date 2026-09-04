package dev.pyric.example.todo.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.tasks.await
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import dev.pyric.auth.AuthLens
import dev.pyric.example.todo.data.Todo
import dev.pyric.example.todo.data.TodoFilter
import dev.pyric.example.todo.data.TodoRepository
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Reactive ViewModel managing Todo state, user authentication, and Security Rules enforcement.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TodoViewModel(
    private val repository: TodoRepository,
    private val auth: FirebaseAuth? = null,
    private val fallbackUserId: String? = null
) : ViewModel() {

    private val _filter = MutableStateFlow(TodoFilter.ALL)
    private val _errorMessage = MutableStateFlow<String?>(null)
    private val _isOperationInProgress = MutableStateFlow(false)

    private val effectiveUserFlow: Flow<Pair<String?, String?>> = if (auth != null) {
        combine(auth.authLensFlow, auth.authStateFlow()) { lens, user ->
            resolveEffectiveUserId(lens, user) to (user?.email ?: user?.displayName)
        }
    } else {
        flowOf(fallbackUserId to null)
    }

    private val todosStream: Flow<List<Todo>> = if (auth != null) {
        effectiveUserFlow.flatMapLatest { (uid, _) ->
            if (uid != null) {
                repository.getTodosStream(uid).catch { cause ->
                    _errorMessage.value = "Rules/Bridge error: ${cause.message ?: "Failed to connect to Pyric sandbox"}"
                    emit(emptyList())
                }
            } else {
                flowOf(emptyList())
            }
        }
    } else {
        repository.getTodosStream(fallbackUserId ?: "").catch { cause ->
            _errorMessage.value = "Bridge error: ${cause.message ?: "Failed to connect to Pyric sandbox"}"
            emit(emptyList())
        }
    }

    val uiState: StateFlow<TodoUiState> = combine(
        todosStream,
        effectiveUserFlow,
        _filter,
        _errorMessage,
        _isOperationInProgress
    ) { todos, (uid, email), filter, error, inProgress ->
        val filtered = when (filter) {
            TodoFilter.ALL -> todos
            TodoFilter.ACTIVE -> todos.filter { !it.completed }
            TodoFilter.COMPLETED -> todos.filter { it.completed }
        }
        val activeCount = todos.count { !it.completed }
        val completedCount = todos.count { it.completed }

        TodoUiState(
            todos = todos,
            filteredTodos = filtered,
            filter = filter,
            isLoading = inProgress && todos.isEmpty(),
            errorMessage = error,
            isConnected = repository.isBridgeConnected() && error == null,
            currentUserId = uid,
            currentUserEmail = email,
            activeCount = activeCount,
            completedCount = completedCount
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = TodoUiState(isLoading = true)
    )

    fun setFilter(filter: TodoFilter) {
        _filter.value = filter
    }

    fun addTodo(title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return

        val targetUid = if (auth != null) {
            uiState.value.currentUserId ?: run {
                _errorMessage.value = "Must be signed in to add todos"
                return
            }
        } else {
            fallbackUserId ?: ""
        }

        viewModelScope.launch {
            try {
                _isOperationInProgress.value = true
                _errorMessage.value = null
                repository.addTodo(trimmed, targetUid)
            } catch (e: Exception) {
                _errorMessage.value = "Failed to add todo: ${e.message}"
            } finally {
                _isOperationInProgress.value = false
            }
        }
    }

    fun triggerUnauthorizedWrite() {
        viewModelScope.launch {
            try {
                _errorMessage.value = null
                repository.triggerUnauthorizedWrite()
            } catch (e: Exception) {
                _errorMessage.value = "Rules check failed (Expected): ${e.message}"
            }
        }
    }

    fun toggleTodo(todo: Todo) {
        viewModelScope.launch {
            try {
                _errorMessage.value = null
                repository.toggleTodo(todo.id, todo.completed)
            } catch (e: Exception) {
                _errorMessage.value = "Failed to update todo: ${e.message}"
            }
        }
    }

    fun deleteTodo(id: String) {
        viewModelScope.launch {
            try {
                _errorMessage.value = null
                repository.deleteTodo(id)
            } catch (e: Exception) {
                _errorMessage.value = "Failed to delete todo: ${e.message}"
            }
        }
    }

    fun signInAnonymously() {
        if (auth == null) return
        viewModelScope.launch {
            try {
                _errorMessage.value = null
                auth.signInAnonymously().await()
            } catch (e: Exception) {
                _errorMessage.value = "Anonymous sign-in failed: ${e.message}"
            }
        }
    }

    fun signInWithEmail(email: String = "alice@example.com", pass: String = "password123") {
        if (auth == null) return
        viewModelScope.launch {
            try {
                _errorMessage.value = null
                auth.signInWithEmailAndPassword(email, pass).await()
            } catch (e: Exception) {
                val msg = e.message ?: ""
                if (msg.contains("user-not-found") || msg.contains("No user found")) {
                    try {
                        auth.createUserWithEmailAndPassword(email, pass).await()
                        return@launch
                    } catch (ce: Exception) {
                        _errorMessage.value = "Sign-in failed: ${ce.message}"
                        return@launch
                    }
                }
                _errorMessage.value = "Sign-in failed: ${e.message}"
            }
        }
    }

    fun signOut() {
        auth?.signOut()
    }

    fun clearError() {
        _errorMessage.value = null
    }

    companion object {
        private fun resolveEffectiveUserId(lens: AuthLens, user: FirebaseUser?): String? {
            return when (lens) {
                is AuthLens.AsUser -> lens.uid
                is AuthLens.Admin -> user?.uid ?: "admin"
                is AuthLens.AppSession, is AuthLens.Anon -> user?.uid
            }
        }
    }
}
