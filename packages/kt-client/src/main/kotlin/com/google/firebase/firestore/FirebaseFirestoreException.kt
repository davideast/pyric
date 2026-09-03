package com.google.firebase.firestore

/**
 * Structured exception mirroring Firebase Android SDK's [FirebaseFirestoreException].
 */
open class FirebaseFirestoreException(
    message: String,
    val code: Code,
    cause: Throwable? = null,
    val denialContext: Any? = null
) : Exception(message, cause) {

    enum class Code(val value: Int) {
        OK(0),
        CANCELLED(1),
        UNKNOWN(2),
        INVALID_ARGUMENT(3),
        DEADLINE_EXCEEDED(4),
        NOT_FOUND(5),
        ALREADY_EXISTS(6),
        PERMISSION_DENIED(7),
        RESOURCE_EXHAUSTED(8),
        FAILED_PRECONDITION(9),
        ABORTED(10),
        OUT_OF_RANGE(11),
        UNIMPLEMENTED(12),
        INTERNAL(13),
        UNAVAILABLE(14),
        DATA_LOSS(15),
        UNAUTHENTICATED(16);

        companion object {
            fun fromWireCode(wireCode: String?): Code {
                return when (wireCode?.lowercase()) {
                    "cancelled", "canceled" -> CANCELLED
                    "invalid-argument" -> INVALID_ARGUMENT
                    "deadline-exceeded" -> DEADLINE_EXCEEDED
                    "not-found" -> NOT_FOUND
                    "already-exists" -> ALREADY_EXISTS
                    "permission-denied" -> PERMISSION_DENIED
                    "resource-exhausted" -> RESOURCE_EXHAUSTED
                    "failed-precondition" -> FAILED_PRECONDITION
                    "aborted" -> ABORTED
                    "out-of-range" -> OUT_OF_RANGE
                    "unimplemented" -> UNIMPLEMENTED
                    "internal" -> INTERNAL
                    "unavailable" -> UNAVAILABLE
                    "data-loss" -> DATA_LOSS
                    "unauthenticated" -> UNAUTHENTICATED
                    else -> UNKNOWN
                }
            }
        }
    }

    override fun toString(): String {
        return if (denialContext != null) {
            "FirebaseFirestoreException($code): $message [denialContext: $denialContext]"
        } else {
            "FirebaseFirestoreException($code): $message"
        }
    }
}
