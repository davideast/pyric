package com.google.firebase.auth

object OAuthProvider {
    class CredentialBuilder internal constructor(private val providerId: String) {
        private var idTokenField: String? = null
        private var accessTokenField: String? = null
        private var rawNonceField: String? = null

        val idToken: String?
            get() = idTokenField

        val accessToken: String?
            get() = accessTokenField

        fun setIdToken(idToken: String): CredentialBuilder {
            this.idTokenField = idToken
            return this
        }

        fun setIdTokenWithRawNonce(idToken: String, rawNonce: String?): CredentialBuilder {
            this.idTokenField = idToken
            this.rawNonceField = rawNonce
            return this
        }

        fun setAccessToken(accessToken: String): CredentialBuilder {
            this.accessTokenField = accessToken
            return this
        }

        fun build(): AuthCredential {
            require(providerId.isNotEmpty()) { "Must specify a non-empty providerId" }
            if (idTokenField.isNullOrEmpty() && accessTokenField.isNullOrEmpty()) {
                throw IllegalArgumentException("Must specify an idToken or an accessToken.")
            }
            return OAuthCredential(providerId, idTokenField, accessTokenField, rawNonceField)
        }
    }

    @JvmStatic
    fun newCredentialBuilder(providerId: String): CredentialBuilder {
        require(providerId.isNotEmpty()) { "Must specify a non-empty providerId" }
        return CredentialBuilder(providerId)
    }

    @JvmStatic
    @JvmOverloads
    fun getCredential(
        providerId: String,
        idToken: String?,
        accessToken: String? = null,
        rawNonce: String? = null
    ): AuthCredential {
        require(providerId.isNotEmpty()) { "Must specify a non-empty providerId" }
        if (idToken.isNullOrEmpty() && accessToken.isNullOrEmpty()) {
            throw IllegalArgumentException("Must specify an idToken or an accessToken.")
        }
        return OAuthCredential(providerId, idToken, accessToken, rawNonce)
    }
}
