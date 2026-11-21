package com.google.firebase.ai.internal

import com.google.firebase.FirebaseApp
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.CountTokensResponse
import com.google.firebase.ai.type.FirebaseAIException
import com.google.firebase.ai.type.GenerateContentResponse
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.Part
import com.google.firebase.ai.type.SafetySetting

/** Internal facade delegating to [AiRequestEncoder], [AiResponseDecoder], and [AiBridgeCallPolicy]. */
internal object AiWireCodec {

    fun encodeGenerateContentRequest(
        prompt: List<Content>,
        generationConfig: GenerationConfig?,
        safetySettings: List<SafetySetting>?,
        systemInstruction: Content?,
        backend: GenerativeBackend
    ): Map<String, Any?> = AiRequestEncoder.encodeGenerateContentRequest(
        prompt = prompt,
        generationConfig = generationConfig,
        safetySettings = safetySettings,
        systemInstruction = systemInstruction,
        backend = backend
    )

    fun encodeCountTokensRequest(
        prompt: List<Content>,
        systemInstruction: Content?
    ): Map<String, Any?> = AiRequestEncoder.encodeCountTokensRequest(prompt, systemInstruction)

    fun encodeContent(content: Content): Map<String, Any?> = AiRequestEncoder.encodeContent(content)

    fun encodePart(part: Part, includeThoughtFlag: Boolean = true): Map<String, Any?> =
        AiRequestEncoder.encodePart(part, includeThoughtFlag)

    fun encodeGenerationConfig(config: GenerationConfig): Map<String, Any?> =
        AiRequestEncoder.encodeGenerationConfig(config)

    fun decodeGenerateContentResponse(raw: Any?): GenerateContentResponse =
        AiResponseDecoder.decodeGenerateContentResponse(raw)

    fun validateResponse(response: GenerateContentResponse): GenerateContentResponse =
        AiResponseDecoder.validateResponse(response)

    fun decodeCountTokensResponse(raw: Any?): CountTokensResponse =
        AiResponseDecoder.decodeCountTokensResponse(raw)

    suspend fun resolveAppCheckClaim(
        app: FirebaseApp,
        useLimitedUseTokens: Boolean
    ): AiAppCheckClaim? = AiBridgeCallPolicy.resolveAppCheckClaim(app, useLimitedUseTokens)

    fun mapBridgeException(error: Throwable): FirebaseAIException =
        AiBridgeCallPolicy.mapBridgeException(error)
}
