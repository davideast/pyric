package com.google.firebase.auth

class EmailAuthCredential internal constructor(
    internal val email: String,
    internal val password: String?,
    internal val emailLink: String? = null
) : AuthCredential(EmailAuthProvider.PROVIDER_ID) {
    init {
        require(email.isNotEmpty()) { "Given String is empty or null" }
        if (password.isNullOrEmpty() && emailLink.isNullOrEmpty()) {
            throw IllegalArgumentException(
                "Cannot create an EmailAuthCredential without a password or emailLink."
            )
        }
    }

    override val signInMethod: String
        get() = if (!password.isNullOrEmpty()) {
            EmailAuthProvider.EMAIL_PASSWORD_SIGN_IN_METHOD
        } else {
            EmailAuthProvider.EMAIL_LINK_SIGN_IN_METHOD
        }

    override fun toWireMap(): Map<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        map["providerId"] = provider
        map["signInMethod"] = signInMethod
        map["email"] = email
        if (!password.isNullOrEmpty()) {
            map["password"] = password
        } else if (!emailLink.isNullOrEmpty()) {
            map["password"] = emailLink
        }
        return map
    }
}
