package com.google.firebase.auth

open class FirebaseAuthException(
    val errorCode: String,
    message: String,
    cause: Throwable? = null
) : Exception("[$errorCode] $message", cause)

/** The user does not exist or is disabled (`ERROR_USER_NOT_FOUND`, `ERROR_USER_DISABLED`). */
open class FirebaseAuthInvalidUserException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)

/** The credential is malformed, expired, or wrong (`ERROR_INVALID_CREDENTIAL`, `ERROR_WRONG_PASSWORD`, `ERROR_INVALID_EMAIL`). */
open class FirebaseAuthInvalidCredentialsException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)
