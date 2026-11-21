package com.google.firebase.ai.type

import java.util.Objects

/** Output modality requested in [GenerationConfig.responseModalities]. */
class ResponseModality private constructor(
    val name: String,
    val ordinal: Int
) {
    internal fun toWireString(): String = name

    override fun equals(other: Any?): Boolean =
        this === other || (other is ResponseModality && ordinal == other.ordinal)

    override fun hashCode(): Int = ordinal

    override fun toString(): String = name

    companion object {
        @JvmField val TEXT: ResponseModality = ResponseModality("TEXT", 0)
        @JvmField val IMAGE: ResponseModality = ResponseModality("IMAGE", 1)
        @JvmField val AUDIO: ResponseModality = ResponseModality("AUDIO", 2)
    }
}

/** Configuration parameters steering model generation. */
class GenerationConfig private constructor(
    val temperature: Float?,
    val topK: Int?,
    val topP: Float?,
    val candidateCount: Int?,
    val maxOutputTokens: Int?,
    val presencePenalty: Float?,
    val frequencyPenalty: Float?,
    val stopSequences: List<String>?,
    val responseMimeType: String?,
    val responseSchema: Any?,
    val responseModalities: List<ResponseModality>?,
    val thinkingConfig: ThinkingConfig?
) {
    fun toBuilder(): Builder = Builder(
        temperature = temperature,
        topK = topK,
        topP = topP,
        candidateCount = candidateCount,
        maxOutputTokens = maxOutputTokens,
        presencePenalty = presencePenalty,
        frequencyPenalty = frequencyPenalty,
        stopSequences = stopSequences,
        responseMimeType = responseMimeType,
        responseSchema = responseSchema,
        responseModalities = responseModalities,
        thinkingConfig = thinkingConfig
    )

    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is GenerationConfig) return false
        return temperature == other.temperature &&
            topK == other.topK &&
            topP == other.topP &&
            candidateCount == other.candidateCount &&
            maxOutputTokens == other.maxOutputTokens &&
            presencePenalty == other.presencePenalty &&
            frequencyPenalty == other.frequencyPenalty &&
            stopSequences == other.stopSequences &&
            responseMimeType == other.responseMimeType &&
            responseSchema == other.responseSchema &&
            responseModalities == other.responseModalities &&
            thinkingConfig == other.thinkingConfig
    }

    override fun hashCode(): Int = Objects.hash(
        temperature,
        topK,
        topP,
        candidateCount,
        maxOutputTokens,
        presencePenalty,
        frequencyPenalty,
        stopSequences,
        responseMimeType,
        responseSchema,
        responseModalities,
        thinkingConfig
    )

    class Builder() {
        @JvmField var temperature: Float? = null
        @JvmField var topK: Int? = null
        @JvmField var topP: Float? = null
        @JvmField var candidateCount: Int? = null
        @JvmField var maxOutputTokens: Int? = null
        @JvmField var presencePenalty: Float? = null
        @JvmField var frequencyPenalty: Float? = null
        @JvmField var stopSequences: List<String>? = null
        @JvmField var responseMimeType: String? = null
        @JvmField var responseSchema: Any? = null
        @JvmField var responseModalities: List<ResponseModality>? = null
        @JvmField var thinkingConfig: ThinkingConfig? = null

        internal constructor(
            temperature: Float?,
            topK: Int?,
            topP: Float?,
            candidateCount: Int?,
            maxOutputTokens: Int?,
            presencePenalty: Float?,
            frequencyPenalty: Float?,
            stopSequences: List<String>?,
            responseMimeType: String?,
            responseSchema: Any?,
            responseModalities: List<ResponseModality>?,
            thinkingConfig: ThinkingConfig?
        ) : this() {
            this.temperature = temperature
            this.topK = topK
            this.topP = topP
            this.candidateCount = candidateCount
            this.maxOutputTokens = maxOutputTokens
            this.presencePenalty = presencePenalty
            this.frequencyPenalty = frequencyPenalty
            this.stopSequences = stopSequences?.toList()
            this.responseMimeType = responseMimeType
            this.responseSchema = responseSchema
            this.responseModalities = responseModalities?.toList()
            this.thinkingConfig = thinkingConfig
        }

        fun setTemperature(temperature: Float?): Builder = apply { this.temperature = temperature }

        fun setTopK(topK: Int?): Builder = apply { this.topK = topK }

        fun setTopP(topP: Float?): Builder = apply { this.topP = topP }

        fun setCandidateCount(candidateCount: Int?): Builder = apply {
            this.candidateCount = candidateCount
        }

        fun setMaxOutputTokens(maxOutputTokens: Int?): Builder = apply {
            this.maxOutputTokens = maxOutputTokens
        }

        fun setPresencePenalty(presencePenalty: Float?): Builder = apply {
            this.presencePenalty = presencePenalty
        }

        fun setFrequencyPenalty(frequencyPenalty: Float?): Builder = apply {
            this.frequencyPenalty = frequencyPenalty
        }

        fun setStopSequences(stopSequences: List<String>?): Builder = apply {
            this.stopSequences = stopSequences
        }

        fun setResponseMimeType(responseMimeType: String?): Builder = apply {
            this.responseMimeType = responseMimeType
        }

        fun setResponseSchema(responseSchema: Any?): Builder = apply {
            this.responseSchema = responseSchema
        }

        fun setResponseModalities(responseModalities: List<ResponseModality>?): Builder = apply {
            this.responseModalities = responseModalities
        }

        fun setThinkingConfig(thinkingConfig: ThinkingConfig?): Builder = apply {
            this.thinkingConfig = thinkingConfig
        }

        fun build(): GenerationConfig = GenerationConfig(
            temperature = temperature,
            topK = topK,
            topP = topP,
            candidateCount = candidateCount,
            maxOutputTokens = maxOutputTokens,
            presencePenalty = presencePenalty,
            frequencyPenalty = frequencyPenalty,
            stopSequences = stopSequences?.toList(),
            responseMimeType = responseMimeType,
            responseSchema = responseSchema,
            responseModalities = responseModalities?.toList(),
            thinkingConfig = thinkingConfig
        )
    }

    companion object {
        @JvmStatic
        fun builder(): Builder = Builder()
    }
}

/** Constructs a [GenerationConfig] using the Kotlin DSL. */
fun generationConfig(init: GenerationConfig.Builder.() -> Unit): GenerationConfig {
    val builder = GenerationConfig.builder()
    builder.init()
    return builder.build()
}

/** Per-model request execution options. */
class RequestOptions @JvmOverloads constructor(
    val timeoutInMillis: Long = DEFAULT_TIMEOUT_MILLIS,
    val autoFunctionCallingTurnLimit: Int = DEFAULT_AUTO_FUNCTION_TURN_LIMIT
) {
    init {
        require(timeoutInMillis > 0L) { "timeoutInMillis must be positive" }
        require(autoFunctionCallingTurnLimit >= 0) { "autoFunctionCallingTurnLimit must be >= 0" }
    }

    companion object {
        const val DEFAULT_TIMEOUT_MILLIS: Long = 180_000L
        const val DEFAULT_AUTO_FUNCTION_TURN_LIMIT: Int = 10
    }
}
