package com.google.firebase.ai.type

import java.util.Objects

/** Source where inference executed. */
class InferenceSource private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is InferenceSource && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val IN_CLOUD: InferenceSource = InferenceSource("IN_CLOUD", 0)
        @JvmField val ON_DEVICE: InferenceSource = InferenceSource("ON_DEVICE", 1)
    }
}

/** Reason why a prompt was blocked prior to generation. */
class BlockReason private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is BlockReason && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val UNKNOWN: BlockReason = BlockReason("UNKNOWN", 0)
        @JvmField val SAFETY: BlockReason = BlockReason("SAFETY", 1)
        @JvmField val OTHER: BlockReason = BlockReason("OTHER", 2)
        @JvmField val BLOCKLIST: BlockReason = BlockReason("BLOCKLIST", 3)
        @JvmField val PROHIBITED_CONTENT: BlockReason = BlockReason("PROHIBITED_CONTENT", 4)

        internal fun fromWire(raw: String?): BlockReason? {
            if (raw.isNullOrEmpty()) return null
            return when (raw) {
                "SAFETY" -> SAFETY
                "OTHER" -> OTHER
                "BLOCKLIST" -> BLOCKLIST
                "PROHIBITED_CONTENT" -> PROHIBITED_CONTENT
                else -> UNKNOWN
            }
        }
    }
}

/** Feedback regarding safety evaluation of the input prompt. */
class PromptFeedback internal constructor(
    val blockReason: BlockReason?,
    val safetyRatings: List<SafetyRating>,
    val blockReasonMessage: String? = null
)

/** Modality classification in token usage breakdowns. */
class ContentModality private constructor(
    val name: String,
    val ordinal: Int
) {
    override fun equals(other: Any?): Boolean =
        this === other || (other is ContentModality && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val UNSPECIFIED: ContentModality = ContentModality("UNSPECIFIED", 0)
        @JvmField val TEXT: ContentModality = ContentModality("TEXT", 1)
        @JvmField val IMAGE: ContentModality = ContentModality("IMAGE", 2)
        @JvmField val VIDEO: ContentModality = ContentModality("VIDEO", 3)
        @JvmField val AUDIO: ContentModality = ContentModality("AUDIO", 4)
        @JvmField val DOCUMENT: ContentModality = ContentModality("DOCUMENT", 5)

        internal fun fromWire(raw: String?): ContentModality = when (raw) {
            "TEXT" -> TEXT
            "IMAGE" -> IMAGE
            "VIDEO" -> VIDEO
            "AUDIO" -> AUDIO
            "DOCUMENT" -> DOCUMENT
            else -> UNSPECIFIED
        }
    }
}

/** Token count attributed to a single [ContentModality]. */
class ModalityTokenCount internal constructor(
    val modality: ContentModality,
    val tokenCount: Int
) {
    operator fun component1(): ContentModality = modality
    operator fun component2(): Int = tokenCount

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is ModalityTokenCount) return false
        return modality == other.modality && tokenCount == other.tokenCount
    }

    override fun hashCode(): Int = Objects.hash(modality, tokenCount)

    override fun toString(): String = "ModalityTokenCount(modality=$modality, tokenCount=$tokenCount)"
}

/** Token accounting metadata returned with a generation response. */
class UsageMetadata internal constructor(
    val promptTokenCount: Int,
    val candidatesTokenCount: Int?,
    val totalTokenCount: Int,
    val cachedContentTokenCount: Int = 0,
    val promptTokensDetails: List<ModalityTokenCount> = emptyList(),
    val candidatesTokensDetails: List<ModalityTokenCount> = emptyList(),
    val cacheTokensDetails: List<ModalityTokenCount> = emptyList(),
    val thoughtsTokenCount: Int = 0,
    val toolUsePromptTokenCount: Int = 0,
    val toolUsePromptTokensDetails: List<ModalityTokenCount> = emptyList()
)

/** Response envelope returned by [com.google.firebase.ai.GenerativeModel.generateContent]. */
class GenerateContentResponse internal constructor(
    val candidates: List<Candidate>,
    val promptFeedback: PromptFeedback?,
    val usageMetadata: UsageMetadata?,
    val modelVersion: String? = null,
    val responseId: String? = null,
    val inferenceSource: InferenceSource = InferenceSource.IN_CLOUD
) {
    /** Concatenated non-thought text parts of the first candidate, or `null` if none exist. */
    val text: String? by lazy {
        val textParts = candidates.firstOrNull()
            ?.content
            ?.parts
            ?.filter { !it.isThought }
            ?.filterIsInstance<TextPart>()
        if (textParts.isNullOrEmpty()) null else textParts.joinToString("") { it.text }
    }

    /** Non-thought [FunctionCallPart] entries on the first candidate. */
    val functionCalls: List<FunctionCallPart> by lazy {
        candidates.firstOrNull()
            ?.content
            ?.parts
            ?.filter { !it.isThought }
            ?.filterIsInstance<FunctionCallPart>()
            .orEmpty()
    }

    /** Concatenated thought-marked text parts of the first candidate, or `null` if none exist. */
    val thoughtSummary: String? by lazy {
        val thoughtTextParts = candidates.firstOrNull()
            ?.content
            ?.parts
            ?.filter { it.isThought }
            ?.filterIsInstance<TextPart>()
        if (thoughtTextParts.isNullOrEmpty()) null else thoughtTextParts.joinToString("") { it.text }
    }

    /** Non-thought [InlineDataPart] entries on the first candidate. */
    val inlineDataParts: List<InlineDataPart> by lazy {
        candidates.firstOrNull()
            ?.content
            ?.parts
            ?.filter { !it.isThought }
            ?.filterIsInstance<InlineDataPart>()
            .orEmpty()
    }
}

/** Response returned by [com.google.firebase.ai.GenerativeModel.countTokens]. */
class CountTokensResponse internal constructor(
    val totalTokens: Int,
    val promptTokensDetails: List<ModalityTokenCount> = emptyList()
) {
    operator fun component1(): Int = totalTokens
    operator fun component2(): List<ModalityTokenCount> = promptTokensDetails

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is CountTokensResponse) return false
        return totalTokens == other.totalTokens && promptTokensDetails == other.promptTokensDetails
    }

    override fun hashCode(): Int = Objects.hash(totalTokens, promptTokensDetails)

    override fun toString(): String =
        "CountTokensResponse(totalTokens=$totalTokens, promptTokensDetails=$promptTokensDetails)"
}
