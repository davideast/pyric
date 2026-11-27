package dev.pyric.debug

import dev.pyric.auth.AuthLens
import dev.pyric.debug.ui.filterCustomClaims
import dev.pyric.debug.ui.formatLensDescription
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LensPreviewFormattingTest {
    @Test
    fun distinguishesSignedInAppSessionFromExplicitImpersonation() {
        val aliceLens = AuthLens.AsUser(uid = "alice-uid")
        assertEquals(
            "App Session UID: alice-uid",
            formatLensDescription(aliceLens, isImpersonating = false)
        )
        assertEquals(
            "Impersonating UID: alice-uid",
            formatLensDescription(aliceLens, isImpersonating = true)
        )
        assertEquals(
            "Admin Bypass (Full permissions)",
            formatLensDescription(AuthLens.Admin, isImpersonating = true)
        )
        assertEquals(
            "Anonymous (Unauthenticated)",
            formatLensDescription(AuthLens.Anon, isImpersonating = false)
        )
    }

    @Test
    fun filtersStandardJwtClaimsFromCustomClaimsDisplay() {
        val token = mapOf<String, Any?>(
            "sub" to "alice-uid",
            "user_id" to "alice-uid",
            "iss" to "https://securetoken.google.com/demo",
            "aud" to "demo",
            "iat" to 1700000000L,
            "exp" to 1700003600L,
            "auth_time" to 1700000000L,
            "email" to "alice@example.com",
            "email_verified" to true,
            "firebase" to mapOf("sign_in_provider" to "password"),
            "role" to "editor",
            "tier" to 2
        )
        assertEquals(
            mapOf<String, Any?>("role" to "editor", "tier" to 2),
            filterCustomClaims(token)
        )
        assertTrue(filterCustomClaims(mapOf("email" to "a@b.com", "sub" to "u1")).isEmpty())
        assertTrue(filterCustomClaims(null).isEmpty())
    }
}
