package com.google.firebase.auth

object GoogleAuthProvider {
    const val PROVIDER_ID = "google.com"
    const val GOOGLE_SIGN_IN_METHOD = "google.com"

    @JvmStatic
    fun getCredential(idToken: String?, accessToken: String?): AuthCredential {
        return GoogleAuthCredential(
            idToken = idToken,
            accessToken = accessToken
        )
    }
}
