package com.google.firebase.auth

class OAuthCredential internal constructor(
    override val provider: String,
    val idToken: String?,
    val accessToken: String?,
    val rawNonce: String? = null
) : AuthCredential(provider) {
    override fun toWireMap(): Map<String, Any?> = mapOf(
        "providerId" to provider,
        "idToken" to idToken,
        "accessToken" to accessToken,
        "rawNonce" to rawNonce
    )
}
