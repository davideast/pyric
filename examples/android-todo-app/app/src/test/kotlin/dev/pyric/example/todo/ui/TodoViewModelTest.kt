package dev.pyric.example.todo.ui

import dev.pyric.example.todo.data.Todo
import dev.pyric.example.todo.data.TodoFilter
import dev.pyric.example.todo.data.TodoRepository
import dev.pyric.example.todo.ui.viewmodel.TodoViewModel
import dev.pyric.example.todo.ui.viewmodel.TodoViewModelFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
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

@OptIn(ExperimentalCoroutinesApi::class)
class TodoViewModelTest {

    private val testDispatcher = StandardTestDispatcher()
    private lateinit var fakeRepository: FakeTodoRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        fakeRepository = FakeTodoRepository()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun testInitialUiState() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        val state = viewModel.uiState.value

        assertEquals(TodoFilter.ALL, state.filter)
        assertTrue(state.todos.isEmpty())
        assertTrue(state.filteredTodos.isEmpty())
    }

    @Test
    fun testStreamEmissionsUpdateUiState() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        fakeRepository.emitTodos(
            listOf(
                Todo(id = "1", title = "Task 1", completed = false),
                Todo(id = "2", title = "Task 2", completed = true)
            )
        )
        advanceUntilIdle()

        val state = viewModel.uiState.value
        assertEquals(2, state.totalCount)
        assertEquals(1, state.activeCount)
        assertEquals(1, state.completedCount)
        assertEquals(2, state.filteredTodos.size)
        assertTrue(state.isConnected)
    }

    @Test
    fun testFilterActiveAndCompleted() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        fakeRepository.emitTodos(
            listOf(
                Todo(id = "1", title = "Task 1", completed = false),
                Todo(id = "2", title = "Task 2", completed = true),
                Todo(id = "3", title = "Task 3", completed = false)
            )
        )
        advanceUntilIdle()

        viewModel.setFilter(TodoFilter.ACTIVE)
        advanceUntilIdle()
        var state = viewModel.uiState.value
        assertEquals(TodoFilter.ACTIVE, state.filter)
        assertEquals(2, state.filteredTodos.size)
        assertTrue(state.filteredTodos.all { !it.completed })

        viewModel.setFilter(TodoFilter.COMPLETED)
        advanceUntilIdle()
        state = viewModel.uiState.value
        assertEquals(TodoFilter.COMPLETED, state.filter)
        assertEquals(1, state.filteredTodos.size)
        assertTrue(state.filteredTodos.all { it.completed })
    }

    @Test
    fun testAddTodoDelegatesToRepository() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        advanceUntilIdle()

        viewModel.addTodo("New item")
        advanceUntilIdle()

        assertEquals(1, fakeRepository.addedTitles.size)
        assertEquals("New item", fakeRepository.addedTitles[0])
    }

    @Test
    fun testAddTodoBlankIgnored() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        advanceUntilIdle()

        viewModel.addTodo("   ")
        advanceUntilIdle()

        assertTrue(fakeRepository.addedTitles.isEmpty())
    }

    @Test
    fun testToggleTodoDelegatesToRepository() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        advanceUntilIdle()

        val todo = Todo(id = "100", title = "Toggle me", completed = false)
        viewModel.toggleTodo(todo)
        advanceUntilIdle()

        assertEquals(1, fakeRepository.toggledCalls.size)
        assertEquals("100" to false, fakeRepository.toggledCalls[0])
    }

    @Test
    fun testDeleteTodoDelegatesToRepository() = runTest {
        val viewModel = TodoViewModel(fakeRepository)
        advanceUntilIdle()

        viewModel.deleteTodo("del-200")
        advanceUntilIdle()

        assertEquals(1, fakeRepository.deletedIds.size)
        assertEquals("del-200", fakeRepository.deletedIds[0])
    }

    @Test
    fun testClearErrorResetsErrorMessage() = runTest {
        val failingRepo = object : TodoRepository {
            override fun getTodosStream(): Flow<List<Todo>> = flow {
                throw RuntimeException("Network down")
            }
            override suspend fun addTodo(title: String) {}
            override suspend fun toggleTodo(id: String, completed: Boolean) {}
            override suspend fun deleteTodo(id: String) {}
            override fun isBridgeConnected(): Boolean = false
        }

        val viewModel = TodoViewModel(failingRepo)
        backgroundScope.launch(kotlinx.coroutines.test.UnconfinedTestDispatcher(testScheduler)) {
            viewModel.uiState.collect()
        }
        advanceUntilIdle()

        assertNotNull(viewModel.uiState.value.errorMessage)
        assertFalse(viewModel.uiState.value.isConnected)

        viewModel.clearError()
        advanceUntilIdle()
        assertEquals(null, viewModel.uiState.value.errorMessage)
    }

    @Test
    fun testViewModelFactory() {
        val factory = TodoViewModelFactory(fakeRepository)
        val vm = factory.create(TodoViewModel::class.java)
        assertNotNull(vm)
    }

    private class FakeTodoRepository : TodoRepository {
        private val streamFlow = MutableSharedFlow<List<Todo>>(replay = 1)
        val addedTitles = mutableListOf<String>()
        val toggledCalls = mutableListOf<Pair<String, Boolean>>()
        val deletedIds = mutableListOf<String>()
        var connected = true

        init {
            streamFlow.tryEmit(emptyList())
        }

        fun emitTodos(todos: List<Todo>) {
            streamFlow.tryEmit(todos)
        }

        override fun getTodosStream(): Flow<List<Todo>> = streamFlow

        override suspend fun addTodo(title: String) {
            addedTitles.add(title)
        }

        override suspend fun toggleTodo(id: String, completed: Boolean) {
            toggledCalls.add(id to completed)
        }

        override suspend fun deleteTodo(id: String) {
            deletedIds.add(id)
        }

        override fun isBridgeConnected(): Boolean = connected
    }
}
