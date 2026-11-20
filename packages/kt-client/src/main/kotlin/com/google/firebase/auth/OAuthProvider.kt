package com.google.firebase.auth

object OAuthProvider {
    class CredentialBuilder internal constructor(private val providerId: String) {
        private var idToken: String? = null
        private var accessToken: String? = null
        private var rawNonce: String? = null

        fun setIdToken(idToken: String): CredentialBuilder {
            this.idToken = idToken
            return this
        }

        fun setIdTokenWithRawNonce(idToken: String, rawNonce: String?): CredentialBuilder {
            this.idToken = idToken
            this.rawNonce = rawNonce
            return this
        }

        fun setAccessToken(accessToken: String): CredentialBuilder {
            this.accessToken = accessToken
            return this
        }

        fun build(): AuthCredential = OAuthCredential(providerId, idToken, accessToken, rawNonce)
    }

    @JvmStatic
    fun newCredentialBuilder(providerId: String): CredentialBuilder = CredentialBuilder(providerId)

    @JvmStatic
    @JvmOverloads
    fun getCredential(
        providerId: String,
        idToken: String?,
        accessToken: String? = null,
        rawNonce: String? = null
    ): AuthCredential = OAuthCredential(providerId, idToken, accessToken, rawNonce)
}
