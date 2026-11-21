package com.google.firebase.auth

class GoogleAuthCredential internal constructor(
    val idToken: String?,
    val accessToken: String?
) : AuthCredential(GoogleAuthProvider.PROVIDER_ID) {
    init {
        if (idToken == null && accessToken == null) {
            throw IllegalArgumentException("Must specify an idToken or an accessToken.")
        }
        if (idToken != null && idToken.isEmpty()) {
            throw IllegalArgumentException("idToken cannot be empty")
        }
        if (accessToken != null && accessToken.isEmpty()) {
            throw IllegalArgumentException("accessToken cannot be empty")
        }
    }

    override val signInMethod: String
        get() = GoogleAuthProvider.GOOGLE_SIGN_IN_METHOD

    override fun toWireMap(): Map<String, Any?> = mapOf(
        "providerId" to provider,
        "signInMethod" to signInMethod,
        "idToken" to idToken,
        "accessToken" to accessToken
    )
}
