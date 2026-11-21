package com.google.firebase.auth

open class OAuthCredential internal constructor(
    override val provider: String,
    open val idToken: String?,
    open val accessToken: String?,
    val rawNonce: String? = null,
    open val secret: String? = null
) : AuthCredential(provider) {
    override val signInMethod: String = provider

    override fun toWireMap(): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        map["providerId"] = provider
        map["signInMethod"] = signInMethod
        map["idToken"] = idToken
        map["accessToken"] = accessToken
        map["rawNonce"] = rawNonce
        if (secret != null) {
            map["secret"] = secret
        }
        return map
    }
}
