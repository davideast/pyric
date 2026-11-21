package com.google.firebase.ai.internal

import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.FileDataPart
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.GenerativeBackend
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.Part
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.ThinkingConfig
import java.util.Base64

internal object AiRequestEncoder {

    fun encodeGenerateContentRequest(
        prompt: List<Content>,
        generationConfig: GenerationConfig?,
        safetySettings: List<SafetySetting>?,
        systemInstruction: Content?,
        backend: GenerativeBackend
    ): Map<String, Any?> {
        val request = LinkedHashMap<String, Any?>()
        request["contents"] = prompt.map(::encodeContent)
        if (generationConfig != null) {
            val encodedConfig = encodeGenerationConfig(generationConfig)
            if (encodedConfig.isNotEmpty()) {
                request["generationConfig"] = encodedConfig
            }
        }
        if (!safetySettings.isNullOrEmpty()) {
            if (backend.isGoogleAI && safetySettings.any { it.method != null }) {
                throw InvalidStateException(
                    "HarmBlockMethod is unsupported by the Google Developer API"
                )
            }
            request["safetySettings"] = safetySettings.map(::encodeSafetySetting)
        }
        if (systemInstruction != null) {
            request["systemInstruction"] = encodeSystemInstruction(systemInstruction)
        }
        return request
    }

    fun encodeCountTokensRequest(
        prompt: List<Content>,
        systemInstruction: Content?
    ): Map<String, Any?> {
        val request = LinkedHashMap<String, Any?>()
        request["contents"] = prompt.map(::encodeContent)
        if (systemInstruction != null) {
            request["systemInstruction"] = encodeSystemInstruction(systemInstruction)
        }
        return request
    }

    fun encodeContent(content: Content): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(2)
        out["role"] = content.role ?: "user"
        out["parts"] = content.parts.map(::encodePart)
        return out
    }

    fun encodeSystemInstruction(instruction: Content): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(2)
        out["role"] = "system"
        out["parts"] = instruction.parts.map { encodePart(it, includeThoughtFlag = false) }
        return out
    }

    fun encodePart(part: Part, includeThoughtFlag: Boolean = true): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        when (part) {
            is TextPart -> {
                out["text"] = part.text
                applyThoughtFields(out, includeThoughtFlag, part.isThought, part.thoughtSignature)
            }
            is InlineDataPart -> {
                val inlineData = LinkedHashMap<String, Any?>(3)
                inlineData["mimeType"] = part.mimeType
                inlineData["data"] = Base64.getEncoder().encodeToString(part.inlineData)
                if (part.displayName != null) {
                    inlineData["displayName"] = part.displayName
                }
                out["inlineData"] = inlineData
                applyThoughtFields(out, includeThoughtFlag, part.isThought, part.thoughtSignature)
            }
            is FileDataPart -> {
                out["fileData"] = mapOf("mimeType" to part.mimeType, "fileUri" to part.uri)
                applyThoughtFields(out, includeThoughtFlag, part.isThought, part.thoughtSignature)
            }
            is FunctionCallPart -> {
                val fn = LinkedHashMap<String, Any?>(3)
                fn["name"] = part.name
                fn["args"] = part.args
                if (part.id != null) fn["id"] = part.id
                out["functionCall"] = fn
                applyThoughtFields(out, includeThoughtFlag, part.isThought, part.thoughtSignature)
            }
            is FunctionResponsePart -> {
                val fnRes = LinkedHashMap<String, Any?>(4)
                fnRes["name"] = part.name
                fnRes["response"] = part.response
                if (part.id != null) fnRes["id"] = part.id
                if (part.parts.isNotEmpty()) {
                    fnRes["parts"] = part.parts.map { encodePart(it, includeThoughtFlag = false) }
                }
                out["functionResponse"] = fnRes
                applyThoughtFields(out, includeThoughtFlag, part.isThought, part.thoughtSignature)
            }
            else -> throw SerializationException(
                "Unsupported Part implementation: ${part.javaClass.simpleName}"
            )
        }
        return out
    }

    private fun applyThoughtFields(
        target: MutableMap<String, Any?>,
        includeThoughtFlag: Boolean,
        isThought: Boolean,
        thoughtSignature: String?
    ) {
        if (includeThoughtFlag && isThought) target["thought"] = true
        if (thoughtSignature != null) target["thoughtSignature"] = thoughtSignature
    }

    fun encodeGenerationConfig(config: GenerationConfig): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>()
        if (config.temperature != null) out["temperature"] = config.temperature.toDouble()
        if (config.topP != null) out["topP"] = config.topP.toDouble()
        if (config.topK != null) out["topK"] = config.topK
        if (config.candidateCount != null) out["candidateCount"] = config.candidateCount
        if (config.maxOutputTokens != null) out["maxOutputTokens"] = config.maxOutputTokens
        if (config.presencePenalty != null) out["presencePenalty"] = config.presencePenalty.toDouble()
        if (config.frequencyPenalty != null) {
            out["frequencyPenalty"] = config.frequencyPenalty.toDouble()
        }
        if (config.stopSequences != null) out["stopSequences"] = config.stopSequences
        if (config.responseMimeType != null) out["responseMimeType"] = config.responseMimeType
        if (config.responseSchema != null) {
            out["responseSchema"] = encodeSchemaValue(config.responseSchema)
        }
        if (config.responseModalities != null) {
            out["responseModalities"] = config.responseModalities.map { it.toWireString() }
        }
        if (config.thinkingConfig != null) {
            out["thinkingConfig"] = encodeThinkingConfig(config.thinkingConfig)
        }
        return out
    }

    private fun encodeSchemaValue(schema: Any): Any = when (schema) {
        is Map<*, *> -> schema
        else -> throw SerializationException(
            "Unsupported responseSchema type: ${schema.javaClass.simpleName}"
        )
    }

    private fun encodeThinkingConfig(thinking: ThinkingConfig): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(3)
        if (thinking.thinkingBudget != null) out["thinkingBudget"] = thinking.thinkingBudget
        if (thinking.includeThoughts != null) out["includeThoughts"] = thinking.includeThoughts
        if (thinking.thinkingLevel != null) {
            out["thinkingLevel"] = thinking.thinkingLevel.toWireString()
        }
        return out
    }

    private fun encodeSafetySetting(setting: SafetySetting): Map<String, Any?> {
        val out = LinkedHashMap<String, Any?>(3)
        out["category"] = setting.harmCategory.wireName
        out["threshold"] = setting.threshold.wireName
        if (setting.method != null) out["method"] = setting.method.wireName
        return out
    }
}
