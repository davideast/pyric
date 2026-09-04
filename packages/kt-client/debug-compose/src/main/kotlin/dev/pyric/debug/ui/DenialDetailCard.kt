package dev.pyric.debug.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pyric.debug.model.FieldDiff
import dev.pyric.debug.model.FieldDiffKind
import dev.pyric.debug.model.RulesDenialRecord

@Composable
fun DenialDetailCard(
    record: RulesDenialRecord,
    onBypassWithAdmin: () -> Unit,
    onImpersonateOwner: ((String) -> Unit)? = null,
    onCopyCitation: (String) -> Unit = {},
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val ctx = record.context
    val method = ctx.request?.method?.uppercase() ?: "REQUEST"
    val path = ctx.request?.path ?: "unknown/path"
    val citation = ctx.rule?.formattedCitation ?: "unknown"
    val expression = ctx.rule?.expression

    val potentialOwnerUid = ctx.resource?.data?.let {
        (it["ownerId"] ?: it["userId"] ?: it["authorId"] ?: it["uid"]) as? String
    } ?: ctx.request?.resourceData?.let {
        (it["ownerId"] ?: it["userId"] ?: it["authorId"] ?: it["uid"]) as? String
    }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clickable { expanded = !expanded }
                .padding(14.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    MethodBadge(method = method)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = record.formattedTime,
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = citation,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    fontWeight = FontWeight.SemiBold,
                    color = PyricDebugColors.ErrorRed
                )
            }

            Spacer(modifier = Modifier.height(6.dp))

            Text(
                text = path,
                fontFamily = FontFamily.Monospace,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                maxLines = if (expanded) 10 else 1,
                overflow = TextOverflow.Ellipsis
            )

            if (expression != null) {
                Spacer(modifier = Modifier.height(8.dp))
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = PyricDebugColors.MonospaceBackground,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(
                        text = expression,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = PyricDebugColors.WarningAmber,
                        modifier = Modifier.padding(8.dp),
                        maxLines = if (expanded) 20 else 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }

            AnimatedVisibility(visible = expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 10.dp)
                ) {
                    // Evaluated Auth
                    Text(
                        text = "Evaluated Auth:",
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = PyricDebugColors.MonospaceBackground,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(8.dp)) {
                            Text(
                                text = "uid: ${ctx.auth?.uid ?: "<null (anonymous / unauthenticated)>"}",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            ctx.auth?.tenant?.let {
                                Text(
                                    text = "tenant: $it",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    color = PyricDebugColors.UserTealLight
                                )
                            }
                            ctx.auth?.token?.let {
                                Text(
                                    text = "claims: $it",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 11.sp,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    // Reasons
                    if (ctx.reasons.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Evaluator Reasons:",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        for (reason in ctx.reasons) {
                            Text(
                                text = "• $reason",
                                fontSize = 11.sp,
                                color = PyricDebugColors.ErrorRed,
                                modifier = Modifier.padding(vertical = 1.dp)
                            )
                        }
                    }

                    // Data Diff
                    val diffs = ctx.computeDataDiff()
                    if (diffs.isNotEmpty()) {
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Data Diff (Request vs Resource):",
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        for (diff in diffs) {
                            DiffRow(diff = diff)
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Action buttons
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        FilledTonalButton(
                            onClick = onBypassWithAdmin,
                            shape = RoundedCornerShape(8.dp),
                            modifier = Modifier.weight(1f),
                            colors = ButtonDefaults.filledTonalButtonColors(
                                containerColor = PyricDebugColors.AdminPurple,
                                contentColor = Color.White
                            )
                        ) {
                            Text("Bypass with Admin", fontSize = 11.sp)
                        }

                        if (potentialOwnerUid != null && potentialOwnerUid != ctx.auth?.uid) {
                            OutlinedButton(
                                onClick = { onImpersonateOwner?.invoke(potentialOwnerUid) },
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.weight(1f)
                            ) {
                                Text("Impersonate Owner", fontSize = 11.sp)
                            }
                        }

                        OutlinedButton(
                            onClick = { onCopyCitation(citation) },
                            shape = RoundedCornerShape(8.dp)
                        ) {
                            Text("Copy Citation", fontSize = 11.sp)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MethodBadge(method: String) {
    val color = when (method) {
        "GET", "QUERY" -> PyricDebugColors.UserTeal
        "SET", "CREATE" -> PyricDebugColors.SuccessGreen
        "UPDATE" -> PyricDebugColors.WarningAmber
        "DELETE" -> PyricDebugColors.ErrorRed
        else -> MaterialTheme.colorScheme.primary
    }
    Text(
        text = method,
        fontSize = 10.sp,
        fontWeight = FontWeight.Bold,
        color = Color.White,
        modifier = Modifier
            .background(color, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

@Composable
private fun DiffRow(diff: FieldDiff) {
    val (label, color) = when (diff.kind) {
        FieldDiffKind.ADDED -> "+ ADD" to PyricDebugColors.SuccessGreen
        FieldDiffKind.MODIFIED -> "~ MOD" to PyricDebugColors.WarningAmber
        FieldDiffKind.REMOVED -> "- DEL" to PyricDebugColors.ErrorRed
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            fontSize = 10.sp,
            fontWeight = FontWeight.Bold,
            color = color,
            modifier = Modifier
                .background(color.copy(alpha = 0.15f), RoundedCornerShape(3.dp))
                .padding(horizontal = 4.dp, vertical = 1.dp)
        )
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = "${diff.path}: ${diff.oldValue ?: "null"} -> ${diff.newValue ?: "null"}",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}
