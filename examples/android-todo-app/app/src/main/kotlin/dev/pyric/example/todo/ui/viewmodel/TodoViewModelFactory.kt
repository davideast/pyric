package dev.pyric.example.todo.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.example.todo.data.TodoRepository

/**
 * Factory for creating [TodoViewModel] instances with a provided [TodoRepository].
 */
class TodoViewModelFactory(
    private val repository: TodoRepository,
    private val auth: FirebaseAuth = FirebaseAuth.getInstance()
) : ViewModelProvider.Factory {

    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T {
        require(modelClass.isAssignableFrom(TodoViewModel::class.java)) {
            "Unknown ViewModel class: ${modelClass.name}"
        }
        return TodoViewModel(repository, auth) as T
    }
}
