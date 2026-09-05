package com.google.firebase.auth

class GetTokenResult(
    val token: String,
    val claims: Map<String, Any?> = emptyMap(),
    val expirationTimestamp: Long = 0L,
    val authTimestamp: Long = 0L,
    val issuedAtTimestamp: Long = 0L,
    val signInProvider: String? = null
)
