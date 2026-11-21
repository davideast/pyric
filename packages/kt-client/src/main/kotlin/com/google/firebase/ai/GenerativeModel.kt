package com.google.firebase.ai

import com.google.firebase.ai.internal.AiStreamSubscription
import com.google.firebase.ai.internal.AiWireCodec
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.CountTokensResponse
import com.google.firebase.ai.type.GenerateContentResponse
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.Tool
import com.google.firebase.ai.type.ToolConfig
import com.google.firebase.ai.type.content
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow

/**
 * Multimodal generative model client backed by Pyric's live AI broker over the worker bridge.
 */
class GenerativeModel internal constructor(
    internal val firebaseAI: FirebaseAI,
    val modelName: String,
    internal val normalizedModelName: String,
    internal val generationConfig: GenerationConfig? = null,
    internal val safetySettings: List<SafetySetting>? = null,
    internal val tools: List<Tool>? = null,
    internal val toolConfig: ToolConfig? = null,
    internal val systemInstruction: Content? = null,
    internal val requestOptions: RequestOptions = RequestOptions()
) {
    /** Generates a response from [prompt] turns. */
    suspend fun generateContent(prompt: List<Content>): GenerateContentResponse {
        try {
            val requestPayload = AiWireCodec.encodeGenerateContentRequest(
                prompt = prompt,
                generationConfig = generationConfig,
                safetySettings = safetySettings,
                tools = tools,
                toolConfig = toolConfig,
                systemInstruction = systemInstruction,
                backend = firebaseAI.backend
            )
            val raw = executeUnaryOp("ai.generateContent", requestPayload)
            val decoded = AiWireCodec.decodeGenerateContentResponse(raw)
            return AiWireCodec.validateResponse(decoded)
        } catch (e: Throwable) {
            throw AiWireCodec.mapBridgeException(e)
        }
    }

    /** Generates a response from one or more [Content] arguments. */
    suspend fun generateContent(
        prompt: Content,
        vararg prompts: Content
    ): GenerateContentResponse = generateContent(listOf(prompt, *prompts))

    /** Generates a response from a plain text [prompt]. */
    suspend fun generateContent(prompt: String): GenerateContentResponse =
        generateContent(listOf(content { text(prompt) }))

    /**
     * Generates a streaming response from [prompt] turns over Pyric's AI stream subscription.
     *
     * Collecting with `.take(1)` or cancelling the collecting coroutine scope immediately sends
     * `worker-unsub` and closes the stream transport.
     */
    fun generateContentStream(prompt: List<Content>): Flow<GenerateContentResponse> = flow {
        val requestPayload = try {
            AiWireCodec.encodeGenerateContentRequest(
                prompt = prompt,
                generationConfig = generationConfig,
                safetySettings = safetySettings,
                tools = tools,
                toolConfig = toolConfig,
                systemInstruction = systemInstruction,
                backend = firebaseAI.backend
            )
        } catch (e: Throwable) {
            throw AiWireCodec.mapBridgeException(e)
        }
        val bridge = firebaseAI.bridgeClient
        val chunkFlow = AiStreamSubscription.openChunkStream(
            url = bridge.url,
            headers = bridge.headers,
            transportFactory = firebaseAI.streamTransportFactory,
            model = normalizedModelName,
            request = requestPayload,
            appCheckClaimProvider = {
                AiWireCodec.resolveAppCheckClaim(
                    app = firebaseAI.app,
                    useLimitedUseTokens = firebaseAI.useLimitedUseAppCheckTokens
                )?.let { mapOf("token" to it.token) }
            },
            timeoutMs = requestOptions.timeoutInMillis,
            parseChunk = { rawChunk ->
                AiWireCodec.validateResponse(AiWireCodec.decodeGenerateContentResponse(rawChunk))
            },
            mapError = AiWireCodec::mapStreamError
        )
        emitAll(chunkFlow)
    }

    /** Generates a streaming response from one or more [Content] arguments. */
    fun generateContentStream(
        prompt: Content,
        vararg prompts: Content
    ): Flow<GenerateContentResponse> = generateContentStream(listOf(prompt, *prompts))

    /** Generates a streaming response from a plain text [prompt]. */
    fun generateContentStream(prompt: String): Flow<GenerateContentResponse> =
        generateContentStream(listOf(content { text(prompt) }))

    /** Starts a stateful multi-turn [Chat] session seeded with [history]. */
    @JvmOverloads
    fun startChat(history: List<Content> = emptyList()): Chat = Chat(this, history)

    /** Counts tokens in [prompt] turns using the broker's deterministic tokenizer. */
    suspend fun countTokens(prompt: List<Content>): CountTokensResponse {
        try {
            val requestPayload = AiWireCodec.encodeCountTokensRequest(
                prompt = prompt,
                systemInstruction = systemInstruction,
                tools = tools,
                generationConfig = generationConfig
            )
            val raw = executeUnaryOp("ai.countTokens", requestPayload)
            return AiWireCodec.decodeCountTokensResponse(raw)
        } catch (e: Throwable) {
            throw AiWireCodec.mapBridgeException(e)
        }
    }

    /** Counts tokens across one or more [Content] turns. */
    suspend fun countTokens(
        prompt: Content,
        vararg prompts: Content
    ): CountTokensResponse = countTokens(listOf(prompt, *prompts))

    /** Counts tokens in a plain text [prompt]. */
    suspend fun countTokens(prompt: String): CountTokensResponse =
        countTokens(listOf(content { text(prompt) }))

    private suspend fun executeUnaryOp(
        method: String,
        requestPayload: Map<String, Any?>
    ): Any? {
        val claim = AiWireCodec.resolveAppCheckClaim(
            app = firebaseAI.app,
            useLimitedUseTokens = firebaseAI.useLimitedUseAppCheckTokens
        )
        val params = LinkedHashMap<String, Any?>(4)
        params["model"] = normalizedModelName
        params["request"] = requestPayload
        if (claim != null) {
            params["appCheck"] = mapOf("token" to claim.token)
            params["appCheckToken"] = claim.token
        }
        return firebaseAI.bridgeClient.op(
            method = method,
            params = params,
            timeoutMs = requestOptions.timeoutInMillis
        )
    }
}
