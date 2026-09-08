package com.google.firebase.auth

object GoogleAuthProvider {
    const val PROVIDER_ID = "google.com"

    @JvmStatic
    fun getCredential(idToken: String?, accessToken: String?): AuthCredential {
        return OAuthCredential(
            provider = PROVIDER_ID,
            idToken = idToken,
            accessToken = accessToken,
            rawNonce = null
        )
    }
}
