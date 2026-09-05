package com.google.firebase.auth

data class AuthResult(
    val user: FirebaseUser?,
    val additionalUserInfo: AdditionalUserInfo? = null
)
