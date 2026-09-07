package dev.pyric.database

class DatabaseError(
    val code: Int,
    val message: String,
    val details: String = ""
) {
    fun toException(): DatabaseException = DatabaseException(message)

    companion object {
        const val PERMISSION_DENIED = -3
        const val DISCONNECTED = -4
        const val OPERATION_FAILED = -2
        const val UNKNOWN_ERROR = -999

        fun fromException(t: Throwable): DatabaseError {
            val msg = t.message ?: "Unknown RTDB error"
            val code = if (msg.contains("PERMISSION_DENIED", ignoreCase = true) ||
                msg.contains("permission-denied", ignoreCase = true)
            ) {
                PERMISSION_DENIED
            } else {
                OPERATION_FAILED
            }
            return DatabaseError(code, msg)
        }
    }
}
