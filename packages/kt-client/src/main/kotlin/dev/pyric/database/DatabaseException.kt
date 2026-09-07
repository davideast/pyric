package dev.pyric.database

class DatabaseException(
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)
