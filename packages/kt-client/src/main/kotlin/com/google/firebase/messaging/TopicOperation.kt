package com.google.firebase.messaging

internal object TopicOperation {
    private const val OLD_TOPIC_PREFIX = "/topics/"
    private const val TOPIC_NAME_PATTERN = "[a-zA-Z0-9-_.~%]{1,900}"
    private val TOPIC_NAME_REGEX = Regex("^$TOPIC_NAME_PATTERN$")

    fun normalizeTopicOrThrow(topic: String?): String {
        val raw = topic ?: throw invalidTopic(null)
        val stripped = if (raw.startsWith(OLD_TOPIC_PREFIX)) {
            raw.substring(OLD_TOPIC_PREFIX.length)
        } else {
            raw
        }
        if (stripped.isEmpty() || !TOPIC_NAME_REGEX.matches(stripped)) {
            throw invalidTopic(stripped)
        }
        return stripped
    }

    private fun invalidTopic(value: String?): IllegalArgumentException {
        return IllegalArgumentException(
            "Invalid topic name: ${value.orEmpty()} does not match the allowed format $TOPIC_NAME_PATTERN."
        )
    }
}
