package com.google.firebase.auth

class FirebaseAuthException(
    val errorCode: String,
    message: String,
    cause: Throwable? = null
) : Exception("[$errorCode] $message", cause)
