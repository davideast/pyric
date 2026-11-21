package com.google.firebase.ai.type

import java.util.Objects

/** Represents a reference to a backend for Firebase AI Logic. */
class GenerativeBackend internal constructor(
    val location: String,
    internal val backendKind: GenerativeBackendKind
) {
    internal val isGoogleAI: Boolean
        get() = backendKind == GenerativeBackendKind.GOOGLE_AI

    internal fun normalizeModelResource(modelName: String): String {
        val trimmed = modelName.trim()
        if (trimmed.isEmpty()) {
            throw InvalidStateException("Model name must not be blank.")
        }
        return when (backendKind) {
            GenerativeBackendKind.GOOGLE_AI -> {
                val bare = if (trimmed.startsWith("models/")) {
                    trimmed.removePrefix("models/")
                } else {
                    trimmed
                }
                "models/$bare"
            }
            GenerativeBackendKind.VERTEX_AI -> {
                when {
                    trimmed.startsWith("models/") -> "publishers/google/$trimmed"
                    trimmed.contains("/") -> trimmed
                    else -> "publishers/google/models/$trimmed"
                }
            }
        }
    }

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is GenerativeBackend) return false
        return when (backendKind) {
            GenerativeBackendKind.GOOGLE_AI -> other.backendKind == GenerativeBackendKind.GOOGLE_AI
            GenerativeBackendKind.VERTEX_AI ->
                other.backendKind == GenerativeBackendKind.VERTEX_AI && other.location == location
        }
    }

    override fun hashCode(): Int = Objects.hash(backendKind, location)

    override fun toString(): String = when (backendKind) {
        GenerativeBackendKind.GOOGLE_AI -> "GenerativeBackend.googleAI()"
        GenerativeBackendKind.VERTEX_AI -> "GenerativeBackend.vertexAI(location=$location)"
    }

    companion object {
        internal const val DEFAULT_VERTEX_LOCATION = "us-central1"
        internal const val DEFAULT_AGENT_PLATFORM_LOCATION = "global"

        /** References the Gemini Developer API (Google AI) backend. */
        @JvmStatic
        fun googleAI(): GenerativeBackend =
            GenerativeBackend("", GenerativeBackendKind.GOOGLE_AI)

        /** References the Vertex AI Gemini API backend. */
        @JvmStatic
        @JvmOverloads
        fun vertexAI(location: String = DEFAULT_VERTEX_LOCATION): GenerativeBackend {
            validateLocation(location)
            return GenerativeBackend(location, GenerativeBackendKind.VERTEX_AI)
        }

        /** References the Agent Platform Gemini API backend. */
        @JvmStatic
        @JvmOverloads
        fun agentPlatform(location: String = DEFAULT_AGENT_PLATFORM_LOCATION): GenerativeBackend {
            validateLocation(location)
            return GenerativeBackend(location, GenerativeBackendKind.VERTEX_AI)
        }

        private fun validateLocation(location: String) {
            if (location.isBlank() || location.contains("/")) {
                throw InvalidLocationException(location)
            }
        }
    }
}

internal enum class GenerativeBackendKind {
    GOOGLE_AI,
    VERTEX_AI
}
