package dev.pyric.debug.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.pyric.auth.AuthLens
import dev.pyric.debug.PyricDebugController
import kotlin.math.roundToInt

@Composable
fun PyricDebugOverlay(
    controller: PyricDebugController,
    modifier: Modifier = Modifier
) {
    val activeLens by controller.activeLens.collectAsState()
    val unviewedCount by controller.unviewedDenialsCount.collectAsState()
    val isSheetVisible by controller.isSheetVisible.collectAsState()

    var offsetX by remember { mutableStateOf(20f) }
    var offsetY by remember { mutableStateOf(100f) }

    PyricDebugTheme {
        Box(modifier = modifier.fillMaxSize()) {
            Box(
                modifier = Modifier
                    .offset { IntOffset(offsetX.roundToInt(), offsetY.roundToInt()) }
                    .pointerInput(Unit) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            offsetX += dragAmount.x
                            offsetY += dragAmount.y
                        }
                    }
                    .padding(8.dp)
            ) {
                BadgedBox(
                    badge = {
                        if (unviewedCount > 0) {
                            Badge(
                                containerColor = PyricDebugColors.ErrorRed,
                                contentColor = Color.White,
                                modifier = Modifier.offset(x = (-4).dp, y = 4.dp)
                            ) {
                                Text(
                                    text = if (unviewedCount > 99) "99+" else "$unviewedCount",
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold
                                )
                            }
                        }
                    }
                ) {
                    val (badgeText, badgeBg) = when (activeLens) {
                        is AuthLens.Admin -> "ADM" to PyricDebugColors.AdminPurple
                        is AuthLens.Anon -> "ANO" to PyricDebugColors.DarkCard
                        is AuthLens.AppSession -> "APP" to PyricDebugColors.UserTeal
                        is AuthLens.AsUser -> {
                            val uid = (activeLens as AuthLens.AsUser).uid
                            uid.take(3).uppercase() to PyricDebugColors.PyricOrange
                        }
                    }

                    Surface(
                        modifier = Modifier
                            .size(54.dp)
                            .shadow(8.dp, CircleShape)
                            .clip(CircleShape)
                            .clickable { controller.setSheetVisible(true) },
                        color = badgeBg,
                        contentColor = Color.White
                    ) {
                        Box(contentAlignment = Alignment.Center) {
                            Text(
                                text = badgeText,
                                fontWeight = FontWeight.Black,
                                fontSize = 13.sp,
                                letterSpacing = 0.5.sp
                            )

                            // Status dot (connected vs disconnected)
                            val isConnected = controller.bridgeClient.isConnected
                            Box(
                                modifier = Modifier
                                    .align(Alignment.BottomEnd)
                                    .padding(4.dp)
                                    .size(10.dp)
                                    .clip(CircleShape)
                                    .background(
                                        if (isConnected) PyricDebugColors.SuccessGreen
                                        else PyricDebugColors.WarningAmber
                                    )
                            )
                        }
                    }
                }
            }

            if (isSheetVisible) {
                PyricDebugBottomSheet(
                    controller = controller,
                    onDismissRequest = { controller.setSheetVisible(false) }
                )
            }
        }
    }
}
