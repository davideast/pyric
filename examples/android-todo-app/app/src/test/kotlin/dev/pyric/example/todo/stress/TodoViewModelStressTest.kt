package dev.pyric.example.todo.stress

import dev.pyric.example.todo.data.Todo
import dev.pyric.example.todo.data.TodoFilter
import dev.pyric.example.todo.data.TodoRepository
import dev.pyric.example.todo.ui.viewmodel.TodoViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.Collections
import java.util.concurrent.atomic.AtomicInteger

@OptIn(ExperimentalCoroutinesApi::class)
class TodoViewModelStressTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var mockRepository: StressableTodoRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepository = StressableTodoRepository()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun testRapidConcurrentToggles() = runTest {
        val viewModel = TodoViewModel(mockRepository)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        val todoList = (1..10).map { id ->
            Todo(id = "item-$id", title = "Task $id", completed = id % 2 == 0)
        }
        mockRepository.emitTodos(todoList)
        advanceUntilIdle()

        // Launch 50 concurrent toggles across random items
        val jobs = (1..50).map { iteration ->
            launch {
                val target = todoList[iteration % todoList.size]
                viewModel.toggleTodo(target)
            }
        }
        jobs.joinAll()
        advanceUntilIdle()

        assertEquals(50, mockRepository.toggleCallCount.get())
        assertNull(viewModel.uiState.value.errorMessage)
    }

    @Test
    fun testRapidFilterSwitchesUnderStreamingLoad() = runTest {
        val viewModel = TodoViewModel(mockRepository)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        val filters = listOf(TodoFilter.ALL, TodoFilter.ACTIVE, TodoFilter.COMPLETED)

        // Rapid interleaved stream emissions and filter changes
        for (i in 1..30) {
            val todos = (1..10).map { id ->
                Todo(id = "t-$id", title = "Task $id", completed = (id + i) % 2 == 0)
            }
            mockRepository.emitTodos(todos)

            val chosenFilter = filters[i % filters.size]
            viewModel.setFilter(chosenFilter)
            advanceUntilIdle()

            val state = viewModel.uiState.value
            assertEquals(chosenFilter, state.filter)
            when (chosenFilter) {
                TodoFilter.ALL -> {
                    assertEquals(10, state.filteredTodos.size)
                }
                TodoFilter.ACTIVE -> {
                    assertTrue(state.filteredTodos.all { !it.completed })
                    assertEquals(state.activeCount, state.filteredTodos.size)
                }
                TodoFilter.COMPLETED -> {
                    assertTrue(state.filteredTodos.all { it.completed })
                    assertEquals(state.completedCount, state.filteredTodos.size)
                }
            }
        }
    }

    @Test
    fun testStreamErrorEmissionAndRecovery() = runTest {
        val errorFlow = MutableSharedFlow<List<Todo>>()
        val recoverableRepo = object : TodoRepository {
            var connected = true
            override fun getTodosStream(): Flow<List<Todo>> = errorFlow
            override suspend fun addTodo(title: String) {}
            override suspend fun toggleTodo(id: String, completed: Boolean) {}
            override suspend fun deleteTodo(id: String) {}
            override fun isBridgeConnected(): Boolean = connected
        }

        val viewModel = TodoViewModel(recoverableRepo)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        // Initial normal emission
        errorFlow.emit(listOf(Todo("1", "Initial", false)))
        advanceUntilIdle()
        assertEquals(1, viewModel.uiState.value.todos.size)
        assertTrue(viewModel.uiState.value.isConnected)

        // Now test failing repository
        val failingRepo = object : TodoRepository {
            override fun getTodosStream(): Flow<List<Todo>> = flow {
                throw IllegalStateException("Simulated bridge disconnection")
            }
            override suspend fun addTodo(title: String) {}
            override suspend fun toggleTodo(id: String, completed: Boolean) {}
            override suspend fun deleteTodo(id: String) {}
            override fun isBridgeConnected(): Boolean = false
        }

        val failingViewModel = TodoViewModel(failingRepo)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            failingViewModel.uiState.collect()
        }
        advanceUntilIdle()

        // Error must be captured, connected set to false, and fallback list is empty
        val errorState = failingViewModel.uiState.value
        assertNotNull(errorState.errorMessage)
        assertTrue(errorState.errorMessage!!.contains("Simulated bridge disconnection"))
        assertFalse(errorState.isConnected)
        assertTrue(errorState.todos.isEmpty())

        // Clearing error resets error message
        failingViewModel.clearError()
        advanceUntilIdle()
        assertNull(failingViewModel.uiState.value.errorMessage)
    }

    @Test
    fun testMutationFailuresAndRecovery() = runTest {
        mockRepository.throwOnAdd = true
        mockRepository.throwOnToggle = true
        mockRepository.throwOnDelete = true

        val viewModel = TodoViewModel(mockRepository)
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        // 1. Add failure
        viewModel.addTodo("Will fail")
        advanceUntilIdle()
        val addErrorState = viewModel.uiState.value
        assertNotNull(addErrorState.errorMessage)
        assertTrue(addErrorState.errorMessage!!.contains("Failed to add todo: Network timeout on add"))
        assertFalse(addErrorState.isLoading)

        viewModel.clearError()
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.errorMessage)

        // 2. Toggle failure
        viewModel.toggleTodo(Todo("1", "Task", false))
        advanceUntilIdle()
        val toggleErrorState = viewModel.uiState.value
        assertNotNull(toggleErrorState.errorMessage)
        assertTrue(toggleErrorState.errorMessage!!.contains("Failed to update todo: Firestore write conflict"))

        viewModel.clearError()
        advanceUntilIdle()
        assertNull(viewModel.uiState.value.errorMessage)

        // 3. Delete failure
        viewModel.deleteTodo("1")
        advanceUntilIdle()
        val deleteErrorState = viewModel.uiState.value
        assertNotNull(deleteErrorState.errorMessage)
        assertTrue(deleteErrorState.errorMessage!!.contains("Failed to delete todo: Document not found"))

        // Recovery: disable throws and execute successful operations
        mockRepository.throwOnAdd = false
        mockRepository.throwOnToggle = false
        mockRepository.throwOnDelete = false
        viewModel.clearError()
        advanceUntilIdle()

        viewModel.addTodo("Recovered task")
        viewModel.toggleTodo(Todo("2", "Task 2", false))
        viewModel.deleteTodo("2")
        advanceUntilIdle()

        assertNull(viewModel.uiState.value.errorMessage)
        assertEquals("Recovered task", mockRepository.addedTitles.last())
    }

    private class StressableTodoRepository : TodoRepository {
        private val streamFlow = MutableSharedFlow<List<Todo>>(replay = 1)
        val addedTitles = Collections.synchronizedList(mutableListOf<String>())
        val toggleCallCount = AtomicInteger(0)
        val deletedIds = Collections.synchronizedList(mutableListOf<String>())

        var throwOnAdd = false
        var throwOnToggle = false
        var throwOnDelete = false
        var connected = true

        init {
            streamFlow.tryEmit(emptyList())
        }

        fun emitTodos(todos: List<Todo>) {
            streamFlow.tryEmit(todos)
        }

        override fun getTodosStream(): Flow<List<Todo>> = streamFlow

        override suspend fun addTodo(title: String) {
            if (throwOnAdd) throw RuntimeException("Network timeout on add")
            addedTitles.add(title)
        }

        override suspend fun toggleTodo(id: String, completed: Boolean) {
            if (throwOnToggle) throw RuntimeException("Firestore write conflict")
            toggleCallCount.incrementAndGet()
        }

        override suspend fun deleteTodo(id: String) {
            if (throwOnDelete) throw RuntimeException("Document not found")
            deletedIds.add(id)
        }

        override fun isBridgeConnected(): Boolean = connected
    }
}
