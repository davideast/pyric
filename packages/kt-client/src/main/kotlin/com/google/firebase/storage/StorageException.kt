package com.google.firebase.storage

import com.google.firebase.FirebaseException
import com.google.firebase.firestore.FirebaseFirestoreException
import java.util.concurrent.CancellationException

/**
 * Exception resulting from an operation on a [StorageReference], matching upstream
 * Android `com.google.firebase.storage.StorageException` error codes and HTTP status reporting.
 */
class StorageException internal constructor(
    val errorCode: Int,
    detailMessage: String = getErrorMessageForCode(errorCode),
    val httpResultCode: Int = 0,
    cause: Throwable? = null
) : FirebaseException(detailMessage, cause) {

    val isRecoverableException: Boolean
        get() = errorCode == ERROR_RETRY_LIMIT_EXCEEDED

    companion object {
        const val ERROR_UNKNOWN: Int = -13000
        const val ERROR_OBJECT_NOT_FOUND: Int = -13010
        const val ERROR_BUCKET_NOT_FOUND: Int = -13011
        const val ERROR_PROJECT_NOT_FOUND: Int = -13012
        const val ERROR_QUOTA_EXCEEDED: Int = -13013
        const val ERROR_NOT_AUTHENTICATED: Int = -13020
        const val ERROR_NOT_AUTHORIZED: Int = -13021
        const val ERROR_RETRY_LIMIT_EXCEEDED: Int = -13030
        const val ERROR_INVALID_CHECKSUM: Int = -13031
        const val ERROR_CANCELED: Int = -13040

        private const val NETWORK_UNAVAILABLE: Int = -2

        @JvmStatic
        fun fromException(exception: Throwable): StorageException {
            val mapped = fromExceptionAndHttpCode(exception, 0)
            return mapped ?: StorageException(ERROR_UNKNOWN, cause = exception)
        }

        @JvmStatic
        fun fromExceptionAndHttpCode(exception: Throwable?, httpResultCode: Int): StorageException? {
            if (exception is StorageException) {
                return exception
            }
            if (isResultSuccess(httpResultCode) && exception == null) {
                return null
            }
            if (exception is FirebaseFirestoreException) {
                return fromWireFailure(exception.wireCode, exception.message, httpResultCode, exception)
            }
            val code = calculateErrorCode(exception, httpResultCode)
            val baseMessage = getErrorMessageForCode(code)
            val detail = exception?.message?.takeIf { it.isNotBlank() }
            val message = if (detail != null && detail != baseMessage) {
                "$baseMessage ($detail)"
            } else {
                baseMessage
            }
            return StorageException(code, message, httpResultCode, exception)
        }

        internal fun fromWireException(throwable: Throwable): StorageException {
            if (throwable is StorageException) return throwable
            if (throwable is FirebaseFirestoreException) {
                return fromWireFailure(throwable.wireCode, throwable.message, 0, throwable)
            }
            return fromException(throwable)
        }

        private fun fromWireFailure(
            rawWireCode: String?,
            rawMessage: String?,
            explicitHttpCode: Int,
            cause: Throwable?
        ): StorageException {
            val normalizedCode = (rawWireCode ?: "").trim().lowercase().removePrefix("storage/")
            val lowerMessage = (rawMessage ?: "").lowercase()

            val resolvedPair: Pair<Int, Int> = when {
                normalizedCode == "object-not-found" || normalizedCode == "not-found" ->
                    ERROR_OBJECT_NOT_FOUND to 404
                normalizedCode == "bucket-not-found" ->
                    ERROR_BUCKET_NOT_FOUND to 404
                normalizedCode == "project-not-found" ->
                    ERROR_PROJECT_NOT_FOUND to 404
                normalizedCode == "quota-exceeded" ||
                    normalizedCode == "payload-too-large" ||
                    normalizedCode == "resource-exhausted" ->
                    ERROR_QUOTA_EXCEEDED to 413
                normalizedCode == "unauthenticated" ->
                    ERROR_NOT_AUTHENTICATED to 401
                normalizedCode == "unauthorized" ||
                    normalizedCode == "unauthorized-app" ||
                    normalizedCode == "permission-denied" ->
                    ERROR_NOT_AUTHORIZED to 403
                normalizedCode == "retry-limit-exceeded" ||
                    normalizedCode == "deadline-exceeded" ||
                    normalizedCode == "unavailable" ->
                    ERROR_RETRY_LIMIT_EXCEEDED to NETWORK_UNAVAILABLE
                normalizedCode == "invalid-checksum" ||
                    normalizedCode == "server-file-wrong-size" ||
                    normalizedCode == "object-changed" ->
                    ERROR_INVALID_CHECKSUM to 409
                normalizedCode == "canceled" || normalizedCode == "cancelled" ->
                    ERROR_CANCELED to 0
                lowerMessage.contains("storage/object-not-found") ->
                    ERROR_OBJECT_NOT_FOUND to 404
                lowerMessage.contains("storage/bucket-not-found") ->
                    ERROR_BUCKET_NOT_FOUND to 404
                lowerMessage.contains("storage/project-not-found") ->
                    ERROR_PROJECT_NOT_FOUND to 404
                lowerMessage.contains("storage/quota-exceeded") || lowerMessage.contains("payload-too-large") ->
                    ERROR_QUOTA_EXCEEDED to 413
                lowerMessage.contains("storage/unauthenticated") ->
                    ERROR_NOT_AUTHENTICATED to 401
                lowerMessage.contains("storage/unauthorized") || lowerMessage.contains("denied by rules") ->
                    ERROR_NOT_AUTHORIZED to 403
                lowerMessage.contains("storage/retry-limit-exceeded") ->
                    ERROR_RETRY_LIMIT_EXCEEDED to NETWORK_UNAVAILABLE
                lowerMessage.contains("storage/invalid-checksum") ->
                    ERROR_INVALID_CHECKSUM to 409
                lowerMessage.contains("storage/canceled") ->
                    ERROR_CANCELED to 0
                else ->
                    ERROR_UNKNOWN to explicitHttpCode
            }

            val errorCode = resolvedPair.first
            val httpCode = if (explicitHttpCode != 0) explicitHttpCode else resolvedPair.second
            val baseMessage = getErrorMessageForCode(errorCode)
            val cleanRaw = rawMessage?.trim()?.takeIf { it.isNotEmpty() }
            val fullMessage = if (cleanRaw != null && cleanRaw != baseMessage) {
                "$baseMessage ($cleanRaw)"
            } else {
                baseMessage
            }
            return StorageException(errorCode, fullMessage, httpCode, cause)
        }

        private fun calculateErrorCode(inner: Throwable?, httpResultCode: Int): Int {
            if (inner is CancellationException) {
                return ERROR_CANCELED
            }
            return when (httpResultCode) {
                NETWORK_UNAVAILABLE -> ERROR_RETRY_LIMIT_EXCEEDED
                401 -> ERROR_NOT_AUTHENTICATED
                402, 413 -> ERROR_QUOTA_EXCEEDED
                403 -> ERROR_NOT_AUTHORIZED
                404 -> ERROR_OBJECT_NOT_FOUND
                409 -> ERROR_INVALID_CHECKSUM
                503, 504 -> ERROR_RETRY_LIMIT_EXCEEDED
                else -> ERROR_UNKNOWN
            }
        }

        private fun isResultSuccess(resultCode: Int): Boolean =
            resultCode == 0 || (resultCode in 200..299)

        internal fun getErrorMessageForCode(errorCode: Int): String = when (errorCode) {
            ERROR_OBJECT_NOT_FOUND -> "Object does not exist at location."
            ERROR_BUCKET_NOT_FOUND -> "Bucket does not exist."
            ERROR_PROJECT_NOT_FOUND -> "Project does not exist."
            ERROR_QUOTA_EXCEEDED ->
                "Quota for bucket exceeded, please view quota on www.firebase.google.com/storage."
            ERROR_NOT_AUTHENTICATED ->
                "User is not authenticated, please authenticate using Firebase Authentication and try again."
            ERROR_NOT_AUTHORIZED -> "User does not have permission to access this object."
            ERROR_RETRY_LIMIT_EXCEEDED -> "The operation retry limit has been exceeded."
            ERROR_INVALID_CHECKSUM ->
                "Object has a checksum which does not match. Please retry the operation."
            ERROR_CANCELED -> "The operation was cancelled."
            else ->
                "An unknown error occurred, please check the HTTP result code and inner exception for server response."
        }
    }
}
