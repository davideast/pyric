package dev.pyric.example.todo.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.pyric.example.todo.data.TodoFilter

@Composable
fun TodoFilterRow(
    selectedFilter: TodoFilter,
    totalCount: Int,
    activeCount: Int,
    completedCount: Int,
    onFilterSelected: (TodoFilter) -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        TodoFilter.entries.forEach { filter ->
            val count = when (filter) {
                TodoFilter.ALL -> totalCount
                TodoFilter.ACTIVE -> activeCount
                TodoFilter.COMPLETED -> completedCount
            }
            FilterChip(
                selected = (selectedFilter == filter),
                onClick = { onFilterSelected(filter) },
                label = { Text("${filter.label} ($count)") },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = MaterialTheme.colorScheme.primaryContainer,
                    selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer
                )
            )
        }
    }
}
