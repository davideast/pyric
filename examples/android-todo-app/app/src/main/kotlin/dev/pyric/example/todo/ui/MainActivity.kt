package dev.pyric.example.todo.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.debug.PyricDebugController
import dev.pyric.debug.ui.PyricDebugOverlay
import dev.pyric.example.todo.data.FirestoreTodoRepository
import dev.pyric.example.todo.ui.screens.TodoScreen
import dev.pyric.example.todo.ui.theme.TodoTheme
import dev.pyric.example.todo.ui.viewmodel.TodoViewModel
import dev.pyric.example.todo.ui.viewmodel.TodoViewModelFactory

class MainActivity : ComponentActivity() {

    private val viewModel: TodoViewModel by viewModels {
        TodoViewModelFactory(FirestoreTodoRepository())
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            val auth = remember { FirebaseAuth.getInstance() }
            val firestore = remember { FirebaseFirestore.getInstance() }
            val debugController = remember { PyricDebugController(auth = auth, firestore = firestore) }

            TodoTheme {
                Box(modifier = Modifier.fillMaxSize()) {
                    TodoScreen(viewModel = viewModel)
                    PyricDebugOverlay(controller = debugController)
                }
            }
        }
    }
}
