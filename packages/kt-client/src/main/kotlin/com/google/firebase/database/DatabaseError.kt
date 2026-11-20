package com.google.firebase.database

import com.google.firebase.firestore.FirebaseFirestoreException

class DatabaseError(
    val code: Int,
    val message: String,
    val details: String = ""
) {
    fun toException(): DatabaseException = DatabaseException("Firebase Database error: $message")

    internal fun toException(cause: Throwable?): DatabaseException =
        DatabaseException("Firebase Database error: $message", cause)

    override fun toString(): String = "DatabaseError: $message"

    companion object {
        const val DATA_STALE = -1
        const val OPERATION_FAILED = -2
        const val PERMISSION_DENIED = -3
        const val DISCONNECTED = -4
        const val EXPIRED_TOKEN = -6
        const val INVALID_TOKEN = -7
        const val MAX_RETRIES = -8
        const val OVERRIDDEN_BY_SET = -9
        const val UNAVAILABLE = -10
        const val USER_CODE_EXCEPTION = -11
        const val NETWORK_ERROR = -24
        const val WRITE_CANCELED = -25
        const val UNKNOWN_ERROR = -999

        @JvmStatic
        fun fromException(t: Throwable): DatabaseError {
            val root = if (t is DatabaseException && t.cause != null) t.cause!! else t
            val firestoreCode = (root as? FirebaseFirestoreException)?.code
                ?: (t as? FirebaseFirestoreException)?.code
            val msg = root.message ?: t.message ?: "Unknown RTDB error"
            val code = when {
                firestoreCode == FirebaseFirestoreException.Code.PERMISSION_DENIED ||
                    msg.contains("PERMISSION_DENIED", ignoreCase = true) ||
                    msg.contains("permission-denied", ignoreCase = true) -> PERMISSION_DENIED
                firestoreCode == FirebaseFirestoreException.Code.UNAVAILABLE ||
                    msg.contains("DISCONNECTED", ignoreCase = true) -> DISCONNECTED
                else -> OPERATION_FAILED
            }
            return DatabaseError(code, msg)
        }

        internal fun wrapTaskException(e: Exception): DatabaseException {
            if (e is DatabaseException) return e
            return fromException(e).toException(e)
        }
    }
}
