package com.google.firebase.ai.type

import java.util.Calendar
import java.util.Objects

/** Reason a candidate stopped generating tokens. */
class FinishReason private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is FinishReason && ordinal == other.ordinal && name == other.name)

    override fun hashCode(): Int = Objects.hash(name, ordinal)

    override fun toString(): String = name

    companion object {
        @JvmField val UNKNOWN: FinishReason = FinishReason("UNKNOWN", 0)
        @JvmField val STOP: FinishReason = FinishReason("STOP", 1)
        @JvmField val MAX_TOKENS: FinishReason = FinishReason("MAX_TOKENS", 2)
        @JvmField val SAFETY: FinishReason = FinishReason("SAFETY", 3)
        @JvmField val RECITATION: FinishReason = FinishReason("RECITATION", 4)
        @JvmField val OTHER: FinishReason = FinishReason("OTHER", 5)
        @JvmField val BLOCKLIST: FinishReason = FinishReason("BLOCKLIST", 6)
        @JvmField val PROHIBITED_CONTENT: FinishReason = FinishReason("PROHIBITED_CONTENT", 7)
        @JvmField val SPII: FinishReason = FinishReason("SPII", 8)
        @JvmField val MALFORMED_FUNCTION_CALL: FinishReason =
            FinishReason("MALFORMED_FUNCTION_CALL", 9)
        @JvmField val IMAGE_SAFETY: FinishReason = FinishReason("IMAGE_SAFETY", 10)
        @JvmField val IMAGE_PROHIBITED_CONTENT: FinishReason =
            FinishReason("IMAGE_PROHIBITED_CONTENT", 11)
        @JvmField val IMAGE_OTHER: FinishReason = FinishReason("IMAGE_OTHER", 12)
        @JvmField val NO_IMAGE: FinishReason = FinishReason("NO_IMAGE", 13)
        @JvmField val IMAGE_RECITATION: FinishReason = FinishReason("IMAGE_RECITATION", 14)
        @JvmField val LANGUAGE: FinishReason = FinishReason("LANGUAGE", 15)
        @JvmField val UNEXPECTED_TOOL_CALL: FinishReason =
            FinishReason("UNEXPECTED_TOOL_CALL", 16)
        @JvmField val TOO_MANY_TOOL_CALLS: FinishReason = FinishReason("TOO_MANY_TOOL_CALLS", 17)
        @JvmField val MISSING_THOUGHT_SIGNATURE: FinishReason =
            FinishReason("MISSING_THOUGHT_SIGNATURE", 18)
        @JvmField val MALFORMED_RESPONSE: FinishReason = FinishReason("MALFORMED_RESPONSE", 19)

        private val byWireName = mapOf(
            "STOP" to STOP,
            "MAX_TOKENS" to MAX_TOKENS,
            "SAFETY" to SAFETY,
            "RECITATION" to RECITATION,
            "OTHER" to OTHER,
            "BLOCKLIST" to BLOCKLIST,
            "PROHIBITED_CONTENT" to PROHIBITED_CONTENT,
            "SPII" to SPII,
            "MALFORMED_FUNCTION_CALL" to MALFORMED_FUNCTION_CALL,
            "IMAGE_SAFETY" to IMAGE_SAFETY,
            "IMAGE_PROHIBITED_CONTENT" to IMAGE_PROHIBITED_CONTENT,
            "IMAGE_OTHER" to IMAGE_OTHER,
            "NO_IMAGE" to NO_IMAGE,
            "IMAGE_RECITATION" to IMAGE_RECITATION,
            "LANGUAGE" to LANGUAGE,
            "UNEXPECTED_TOOL_CALL" to UNEXPECTED_TOOL_CALL,
            "TOO_MANY_TOOL_CALLS" to TOO_MANY_TOOL_CALLS,
            "MISSING_THOUGHT_SIGNATURE" to MISSING_THOUGHT_SIGNATURE,
            "MALFORMED_RESPONSE" to MALFORMED_RESPONSE
        )

        internal fun fromWire(raw: String?): FinishReason? {
            if (raw.isNullOrEmpty()) return null
            if (raw == "FINISH_REASON_UNSPECIFIED" || raw == "UNSPECIFIED") return UNKNOWN
            return byWireName[raw] ?: UNKNOWN
        }
    }
}

/** Likelihood that content matches a [HarmCategory]. */
class HarmProbability private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is HarmProbability && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val UNKNOWN: HarmProbability = HarmProbability("UNKNOWN", 0)
        @JvmField val NEGLIGIBLE: HarmProbability = HarmProbability("NEGLIGIBLE", 1)
        @JvmField val LOW: HarmProbability = HarmProbability("LOW", 2)
        @JvmField val MEDIUM: HarmProbability = HarmProbability("MEDIUM", 3)
        @JvmField val HIGH: HarmProbability = HarmProbability("HIGH", 4)

        internal fun fromWire(raw: String?): HarmProbability = when (raw) {
            "NEGLIGIBLE" -> NEGLIGIBLE
            "LOW" -> LOW
            "MEDIUM" -> MEDIUM
            "HIGH" -> HIGH
            else -> UNKNOWN
        }
    }
}

/** Severity level of potential harm in content. */
class HarmSeverity private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is HarmSeverity && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val UNKNOWN: HarmSeverity = HarmSeverity("UNKNOWN", 0)
        @JvmField val NEGLIGIBLE: HarmSeverity = HarmSeverity("NEGLIGIBLE", 1)
        @JvmField val LOW: HarmSeverity = HarmSeverity("LOW", 2)
        @JvmField val MEDIUM: HarmSeverity = HarmSeverity("MEDIUM", 3)
        @JvmField val HIGH: HarmSeverity = HarmSeverity("HIGH", 4)
        @JvmField val UNSUPPORTED: HarmSeverity = HarmSeverity("UNSUPPORTED", 5)

        internal fun fromWire(raw: String?): HarmSeverity = when (raw) {
            "HARM_SEVERITY_NEGLIGIBLE", "NEGLIGIBLE" -> NEGLIGIBLE
            "HARM_SEVERITY_LOW", "LOW" -> LOW
            "HARM_SEVERITY_MEDIUM", "MEDIUM" -> MEDIUM
            "HARM_SEVERITY_HIGH", "HIGH" -> HIGH
            "HARM_SEVERITY_UNSUPPORTED", "UNSUPPORTED" -> UNSUPPORTED
            else -> UNKNOWN
        }
    }
}

/** Safety rating assessment for a specific [HarmCategory]. */
class SafetyRating internal constructor(
    val category: HarmCategory,
    val probability: HarmProbability,
    val probabilityScore: Float = 0f,
    val blocked: Boolean? = null,
    val severity: HarmSeverity? = null,
    val severityScore: Float? = null
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SafetyRating) return false
        return category == other.category &&
            probability == other.probability &&
            probabilityScore == other.probabilityScore &&
            blocked == other.blocked &&
            severity == other.severity &&
            severityScore == other.severityScore
    }

    override fun hashCode(): Int = Objects.hash(
        category,
        probability,
        probabilityScore,
        blocked,
        severity,
        severityScore
    )
}

/** Attribution metadata for a single cited external source. */
class Citation internal constructor(
    val title: String? = null,
    val startIndex: Int = 0,
    val endIndex: Int,
    val uri: String? = null,
    val license: String? = null,
    val publicationDate: Calendar? = null
)

/** Collection of [Citation] source attributions on a [Candidate]. */
class CitationMetadata internal constructor(
    val citations: List<Citation>
)

/** A single candidate response generated by the model. */
class Candidate internal constructor(
    val content: Content,
    val safetyRatings: List<SafetyRating> = emptyList(),
    val citationMetadata: CitationMetadata? = null,
    val finishReason: FinishReason? = null,
    val finishMessage: String? = null,
    val index: Int = 0
)
