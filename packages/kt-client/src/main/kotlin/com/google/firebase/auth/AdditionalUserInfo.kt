package com.google.firebase.auth

class AdditionalUserInfo(
    val providerId: String? = null,
    val isNewUser: Boolean = false,
    val profile: Map<String, Any?> = emptyMap(),
    val username: String? = null
)
