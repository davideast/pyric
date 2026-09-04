package dev.pyric.example.todo.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.pyric.example.todo.ui.components.AddTodoDialog
import dev.pyric.example.todo.ui.components.EmptyState
import dev.pyric.example.todo.ui.components.TodoFilterRow
import dev.pyric.example.todo.ui.components.TodoList
import dev.pyric.example.todo.ui.components.TodoTopAppBar
import dev.pyric.example.todo.ui.viewmodel.TodoViewModel

@Composable
fun TodoScreen(
    viewModel: TodoViewModel,
    modifier: Modifier = Modifier
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    var showAddDialog by remember { mutableStateOf(false) }

    LaunchedEffect(state.errorMessage) {
        state.errorMessage?.let { error ->
            snackbarHostState.showSnackbar(message = error)
            viewModel.clearError()
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TodoTopAppBar(
                isConnected = state.isConnected,
                onUnauthorizedWriteClick = viewModel::triggerUnauthorizedWrite
            )
        },
        snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
        floatingActionButton = {
            if (state.isAuthenticated) {
                FloatingActionButton(
                    onClick = { showAddDialog = true }
                ) {
                    Icon(imageVector = Icons.Default.Add, contentDescription = "Add Todo")
                }
            }
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            if (!state.isAuthenticated) {
                UnauthenticatedContent(
                    onSignInAnonymous = viewModel::signInAnonymously,
                    onSignInAlice = { viewModel.signInWithEmail() },
                    modifier = Modifier.weight(1f)
                )
            } else {
                UserHeaderBar(
                    userId = state.currentUserId.orEmpty(),
                    userEmail = state.currentUserEmail,
                    onSignOut = viewModel::signOut,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp)
                )

                TodoFilterRow(
                    selectedFilter = state.filter,
                    totalCount = state.totalCount,
                    activeCount = state.activeCount,
                    completedCount = state.completedCount,
                    onFilterSelected = viewModel::setFilter,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 4.dp)
                )

                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .weight(1f)
                ) {
                    when {
                        state.isLoading -> {
                            CircularProgressIndicator(
                                modifier = Modifier.align(Alignment.Center)
                            )
                        }
                        state.isFilterEmpty -> {
                            EmptyState(
                                filter = state.filter,
                                modifier = Modifier.align(Alignment.Center)
                            )
                        }
                        else -> {
                            TodoList(
                                todos = state.filteredTodos,
                                onToggle = viewModel::toggleTodo,
                                onDelete = viewModel::deleteTodo,
                                modifier = Modifier.fillMaxSize()
                            )
                        }
                    }
                }
            }
        }

        if (showAddDialog) {
            AddTodoDialog(
                onDismiss = { showAddDialog = false },
                onConfirm = { title ->
                    viewModel.addTodo(title)
                    showAddDialog = false
                }
            )
        }
    }
}

@Composable
private fun UserHeaderBar(
    userId: String,
    userEmail: String?,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier
) {
    Card(modifier = modifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    imageVector = Icons.Default.Person,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(20.dp)
                )
                Text(
                    text = "User: ${userEmail ?: userId.take(8)}",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(start = 8.dp)
                )
            }
            OutlinedButton(
                onClick = onSignOut
            ) {
                Text("Sign Out", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun UnauthenticatedContent(
    onSignInAnonymous: () -> Unit,
    onSignInAlice: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(
            imageVector = Icons.Default.Lock,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(64.dp)
        )
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Authentication Required",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = "Firestore security rules enforce:\nallow read, write: if request.auth.uid == resource.data.userId;",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(24.dp))
        Button(
            onClick = onSignInAnonymous,
            modifier = Modifier.fillMaxWidth(0.8f)
        ) {
            Text("Sign In Anonymously")
        }
        Spacer(modifier = Modifier.height(8.dp))
        OutlinedButton(
            onClick = onSignInAlice,
            modifier = Modifier.fillMaxWidth(0.8f)
        ) {
            Text("Sign In as Alice (Email/Password)")
        }
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Or tap the Pyric Chip overlay floating above to 1-tap impersonate sandbox users or toggle Admin Bypass.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.outline,
            textAlign = TextAlign.Center
        )
    }
}
