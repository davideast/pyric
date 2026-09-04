package dev.pyric.auth

import kotlinx.coroutines.flow.StateFlow

interface CredentialsProvider {
    fun getEffectiveLens(): AuthLens
    val authLensFlow: StateFlow<AuthLens>
}
