package com.google.firebase.auth

open class FirebaseAuthException(
    val errorCode: String,
    message: String,
    cause: Throwable? = null
) : Exception("[$errorCode] $message", cause)

/** The user does not exist, is disabled, or has an expired/revoked token (`ERROR_USER_NOT_FOUND`, `ERROR_USER_DISABLED`, `ERROR_USER_TOKEN_EXPIRED`). */
open class FirebaseAuthInvalidUserException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)

/** The credential or custom token is malformed, mismatched, expired, or wrong (`ERROR_INVALID_CREDENTIAL`, `ERROR_WRONG_PASSWORD`, `ERROR_INVALID_EMAIL`, `ERROR_INVALID_CUSTOM_TOKEN`, `ERROR_CUSTOM_TOKEN_MISMATCH`). */
open class FirebaseAuthInvalidCredentialsException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)

/** An account already exists with the given email or credential (`ERROR_EMAIL_ALREADY_IN_USE`, `ERROR_ACCOUNT_EXISTS_WITH_DIFFERENT_CREDENTIAL`, `ERROR_CREDENTIAL_ALREADY_IN_USE`). */
open class FirebaseAuthUserCollisionException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)

/** The password is too weak (`ERROR_WEAK_PASSWORD`). */
open class FirebaseAuthWeakPasswordException(
    errorCode: String,
    message: String,
    val reason: String? = null,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)

/** Sensitive user operation requires recent authentication (`ERROR_REQUIRES_RECENT_LOGIN`). */
open class FirebaseAuthRecentLoginRequiredException(
    errorCode: String,
    message: String,
    cause: Throwable? = null
) : FirebaseAuthException(errorCode, message, cause)
