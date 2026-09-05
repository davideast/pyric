package dev.pyric.debug.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pyric.auth.AuthLens
import dev.pyric.debug.DebugTab
import dev.pyric.debug.PyricDebugController

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PyricDebugBottomSheet(
    controller: PyricDebugController,
    onDismissRequest: () -> Unit,
    modifier: Modifier = Modifier
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val selectedTab by controller.selectedTab.collectAsState()
    val unviewedCount by controller.unviewedDenialsCount.collectAsState()

    ModalBottomSheet(
        onDismissRequest = onDismissRequest,
        sheetState = sheetState,
        modifier = modifier.fillMaxHeight(0.9f),
        containerColor = MaterialTheme.colorScheme.surface
    ) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = "Pyric Debug Companion",
                    style = MaterialTheme.typography.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
                TextButton(onClick = onDismissRequest) {
                    Text("Close")
                }
            }

            TabRow(
                selectedTabIndex = selectedTab.ordinal,
                containerColor = MaterialTheme.colorScheme.surface
            ) {
                Tab(
                    selected = selectedTab == DebugTab.IDENTITY,
                    onClick = { controller.setSelectedTab(DebugTab.IDENTITY) },
                    text = { Text("Identity & Users", fontWeight = FontWeight.SemiBold) }
                )
                Tab(
                    selected = selectedTab == DebugTab.RULES_DENIALS,
                    onClick = { controller.setSelectedTab(DebugTab.RULES_DENIALS) },
                    text = {
                        BadgedBox(
                            badge = {
                                if (unviewedCount > 0) {
                                    Badge(
                                        containerColor = PyricDebugColors.ErrorRed,
                                        contentColor = Color.White
                                    ) {
                                        Text("$unviewedCount")
                                    }
                                }
                            }
                        ) {
                            Text("Rules Denials", fontWeight = FontWeight.SemiBold)
                        }
                    }
                )
            }

            Box(modifier = Modifier.fillMaxWidth().height(520.dp)) {
                when (selectedTab) {
                    DebugTab.IDENTITY -> {
                        IdentityTabContent(controller = controller)
                    }
                    DebugTab.RULES_DENIALS -> {
                        RulesDenialsTabContent(controller = controller)
                    }
                }
            }
        }
    }
}

@Composable
private fun IdentityTabContent(controller: PyricDebugController) {
    val activeLens by controller.activeLens.collectAsState()
    val isAdminBypass by controller.isAdminBypassActive.collectAsState()
    val users by controller.filteredUsers.collectAsState()
    val searchQuery by controller.userSearchQuery.collectAsState()
    val isLoadingUsers by controller.isLoadingUsers.collectAsState()

    LazyColumn(modifier = Modifier.fillMaxSize()) {
        item {
            // Admin Bypass Card
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = if (isAdminBypass) {
                        PyricDebugColors.AdminPurple.copy(alpha = 0.15f)
                    } else {
                        MaterialTheme.colorScheme.surfaceVariant
                    }
                )
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(
                                text = "Admin Bypass",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold,
                                color = if (isAdminBypass) PyricDebugColors.AdminPurpleLight else MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                text = if (isAdminBypass) "Bypassing security rules (actAs: admin)" else "Evaluate security rules normally",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = isAdminBypass,
                            onCheckedChange = { controller.toggleAdminBypass(it) },
                            colors = SwitchDefaults.colors(
                                checkedThumbColor = Color.White,
                                checkedTrackColor = PyricDebugColors.AdminPurple
                            )
                        )
                    }
                }
            }
        }

        item {
            // Active Lens Preview Card
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                )
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "Current Auth Lens:",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold
                        )
                        OutlinedButton(
                            onClick = { controller.resetToAppSession() },
                            shape = RoundedCornerShape(8.dp),
                            colors = ButtonDefaults.outlinedButtonColors()
                        ) {
                            Text("Reset to App Session", fontSize = 11.sp)
                        }
                    }

                    Spacer(modifier = Modifier.height(6.dp))

                    val lensDescription = when (activeLens) {
                        is AuthLens.Admin -> "Admin Bypass (Full permissions)"
                        is AuthLens.Anon -> "Anonymous (Unauthenticated)"
                        is AuthLens.AppSession -> "App Session (Default client identity)"
                        is AuthLens.AsUser -> {
                            val userLens = activeLens as AuthLens.AsUser
                            "Impersonating UID: ${userLens.uid}"
                        }
                    }

                    Text(
                        text = lensDescription,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.primary
                    )

                    if (activeLens is AuthLens.AsUser) {
                        val userLens = activeLens as AuthLens.AsUser
                        userLens.tenant?.let {
                            Text(
                                text = "Tenant: $it",
                                style = MaterialTheme.typography.bodySmall,
                                color = PyricDebugColors.UserTealLight
                            )
                        }
                        userLens.token?.let {
                            Text(
                                text = "Custom Claims: $it",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
        }

        item {
            UserSelectionList(
                users = users,
                searchQuery = searchQuery,
                isLoading = isLoadingUsers,
                activeLens = activeLens,
                onSearchQueryChanged = { controller.setUserSearchQuery(it) },
                onRefreshUsers = { controller.refreshUsers() },
                onUserSelected = { controller.impersonateUser(it) },
                onAnonymousSelected = { controller.impersonateAnonymous() }
            )
        }
    }
}

@Composable
private fun RulesDenialsTabContent(controller: PyricDebugController) {
    val denials by controller.denials.collectAsState()

    Column(modifier = Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(
                text = "Recorded Denials (${denials.size})",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold
            )
            if (denials.isNotEmpty()) {
                TextButton(onClick = { controller.clearDenials() }) {
                    Text("Clear All", color = PyricDebugColors.ErrorRed)
                }
            }
        }

        if (denials.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(32.dp),
                contentAlignment = Alignment.Center
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "No security rules denials recorded.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "PERMISSION_DENIED responses from the sandbox will appear here with CEL line citations and data diffs.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        fontSize = 12.sp
                    )
                }
            }
        } else {
            LazyColumn(modifier = Modifier.fillMaxWidth().weight(1f)) {
                items(denials, key = { it.id }) { record ->
                    DenialDetailCard(
                        record = record,
                        onBypassWithAdmin = {
                            controller.toggleAdminBypass(true)
                        },
                        onImpersonateOwner = { ownerUid ->
                            controller.impersonateUid(ownerUid)
                        }
                    )
                }
            }
        }
    }
}
