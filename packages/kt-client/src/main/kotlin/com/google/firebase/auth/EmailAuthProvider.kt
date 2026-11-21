package com.google.firebase.auth

object EmailAuthProvider {
    const val PROVIDER_ID = "password"
    const val EMAIL_PASSWORD_SIGN_IN_METHOD = "password"
    const val EMAIL_LINK_SIGN_IN_METHOD = "emailLink"

    @JvmStatic
    fun getCredential(email: String, password: String): AuthCredential {
        require(email.isNotEmpty()) { "Given String is empty or null" }
        require(password.isNotEmpty()) { "Given String is empty or null" }
        return EmailAuthCredential(email = email, password = password, emailLink = null)
    }

    @JvmStatic
    fun getCredentialWithLink(email: String, emailLink: String): AuthCredential {
        require(email.isNotEmpty()) { "Given String is empty or null" }
        require(emailLink.isNotEmpty()) {
            "Given link is not a valid email link. Please use FirebaseAuth#isSignInWithEmailLink(String) to determine this before calling this function"
        }
        return EmailAuthCredential(email = email, password = null, emailLink = emailLink)
    }
}
