package dev.pyric.example.todo.data

/**
 * Filter criteria for filtering todos in the UI.
 */
enum class TodoFilter(val label: String) {
    ALL("All"),
    ACTIVE("Active"),
    COMPLETED("Completed")
}
