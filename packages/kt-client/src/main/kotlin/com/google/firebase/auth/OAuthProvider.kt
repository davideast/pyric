package com.google.firebase.auth

object OAuthProvider {
    @JvmStatic
    @JvmOverloads
    fun getCredential(
        providerId: String,
        idToken: String?,
        accessToken: String? = null,
        rawNonce: String? = null
    ): AuthCredential = OAuthCredential(providerId, idToken, accessToken, rawNonce)
}
