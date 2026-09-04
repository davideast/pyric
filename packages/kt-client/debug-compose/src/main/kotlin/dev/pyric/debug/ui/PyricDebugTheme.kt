package dev.pyric.debug.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object PyricDebugColors {
    val PyricOrange = Color(0xFFFF6D00)
    val PyricOrangeLight = Color(0xFFFF9E40)
    val AdminPurple = Color(0xFF9C27B0)
    val AdminPurpleLight = Color(0xFFBA68C8)
    val UserTeal = Color(0xFF00897B)
    val UserTealLight = Color(0xFF4DB6AC)
    val ErrorRed = Color(0xFFE53935)
    val WarningAmber = Color(0xFFFFB300)
    val SuccessGreen = Color(0xFF43A047)
    val DarkSurface = Color(0xFF1A1D24)
    val DarkCard = Color(0xFF242832)
    val DarkBackground = Color(0xFF121418)
    val MonospaceBackground = Color(0xFF0E1014)
}

private val DarkColorScheme = darkColorScheme(
    primary = PyricDebugColors.PyricOrange,
    onPrimary = Color.Black,
    primaryContainer = Color(0xFF422100),
    onPrimaryContainer = Color(0xFFFFDCC2),
    secondary = PyricDebugColors.AdminPurple,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFF3B1547),
    onSecondaryContainer = Color(0xFFF3D8FA),
    tertiary = PyricDebugColors.UserTeal,
    onTertiary = Color.White,
    surface = PyricDebugColors.DarkSurface,
    onSurface = Color(0xFFE2E2E6),
    surfaceVariant = PyricDebugColors.DarkCard,
    onSurfaceVariant = Color(0xFFC4C7D0),
    background = PyricDebugColors.DarkBackground,
    onBackground = Color(0xFFE2E2E6),
    error = PyricDebugColors.ErrorRed,
    onError = Color.White
)

private val LightColorScheme = lightColorScheme(
    primary = PyricDebugColors.PyricOrange,
    onPrimary = Color.White,
    surface = Color(0xFFF8F9FA),
    onSurface = Color(0xFF1A1C1E),
    surfaceVariant = Color(0xFFEAECEF),
    onSurfaceVariant = Color(0xFF44474E),
    background = Color(0xFFFFFFFF),
    onBackground = Color(0xFF1A1C1E),
    error = PyricDebugColors.ErrorRed,
    onError = Color.White
)

@Composable
fun PyricDebugTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme
    MaterialTheme(
        colorScheme = colorScheme,
        content = content
    )
}
