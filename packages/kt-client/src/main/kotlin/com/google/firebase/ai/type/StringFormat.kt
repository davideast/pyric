package com.google.firebase.ai.type

/**
 * Format constraint for string [Schema] definitions.
 */
abstract class StringFormat internal constructor(
    internal val value: String
) {
    class Custom(value: String) : StringFormat(value)
}
