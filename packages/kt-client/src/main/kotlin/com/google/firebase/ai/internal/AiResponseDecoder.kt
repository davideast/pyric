package com.google.firebase.ai.internal

import com.google.firebase.ai.type.BlockReason
import com.google.firebase.ai.type.Candidate
import com.google.firebase.ai.type.Citation
import com.google.firebase.ai.type.CitationMetadata
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.ContentModality
import com.google.firebase.ai.type.CountTokensResponse
import com.google.firebase.ai.type.FileDataPart
import com.google.firebase.ai.type.FinishReason
import com.google.firebase.ai.type.FunctionCallPart
import com.google.firebase.ai.type.FunctionResponsePart
import com.google.firebase.ai.type.GenerateContentResponse
import com.google.firebase.ai.type.HarmCategory
import com.google.firebase.ai.type.HarmProbability
import com.google.firebase.ai.type.HarmSeverity
import com.google.firebase.ai.type.InlineDataPart
import com.google.firebase.ai.type.ModalityTokenCount
import com.google.firebase.ai.type.Part
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.PromptFeedback
import com.google.firebase.ai.type.ResponseStoppedException
import com.google.firebase.ai.type.SafetyRating
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.UsageMetadata
import java.util.Base64
import java.util.Calendar

internal object AiResponseDecoder {

    fun decodeGenerateContentResponse(raw: Any?): GenerateContentResponse {
        val map = raw as? Map<*, *> ?: throw SerializationException(
            "Expected GenerateContentResponse JSON object from bridge, got: ${raw?.javaClass?.simpleName ?: "null"}"
        )
        val rawCandidates = map["candidates"] as? List<*>
        val candidates = rawCandidates?.mapIndexedNotNull { idx, item ->
            (item as? Map<*, *>)?.let { decodeCandidate(it, idx) }
        }.orEmpty()
        val promptFeedback = (map["promptFeedback"] as? Map<*, *>)?.let(::decodePromptFeedback)
        val usageMetadata = (map["usageMetadata"] as? Map<*, *>)?.let(::decodeUsageMetadata)
        val modelVersion = map["modelVersion"] as? String
        val responseId = map["responseId"] as? String
        return GenerateContentResponse(
            candidates = candidates,
            promptFeedback = promptFeedback,
            usageMetadata = usageMetadata,
            modelVersion = modelVersion,
            responseId = responseId
        )
    }

    fun validateResponse(response: GenerateContentResponse): GenerateContentResponse {
        if (response.candidates.isEmpty() && response.promptFeedback == null) {
            throw SerializationException("Error deserializing response, found no valid fields")
        }
        if (response.promptFeedback?.blockReason != null) {
            throw PromptBlockedException(response)
        }
        val nonStopReason = response.candidates
            .mapNotNull { it.finishReason }
            .firstOrNull { it != FinishReason.STOP }
        if (nonStopReason != null) {
            throw ResponseStoppedException(response)
        }
        return response
    }

    fun decodeCountTokensResponse(raw: Any?): CountTokensResponse {
        val map = raw as? Map<*, *> ?: throw SerializationException(
            "Expected CountTokensResponse JSON object from bridge, got: ${raw?.javaClass?.simpleName ?: "null"}"
        )
        val totalTokens = (map["totalTokens"] as? Number)?.toInt() ?: 0
        val details = decodeModalityDetails(map["promptTokensDetails"])
        return CountTokensResponse(totalTokens = totalTokens, promptTokensDetails = details)
    }

    private fun decodeCandidate(map: Map<*, *>, defaultIndex: Int): Candidate {
        val contentMap = map["content"] as? Map<*, *>
        val content = if (contentMap != null) {
            decodeContent(contentMap, defaultRole = "model")
        } else {
            Content(role = "model", parts = emptyList())
        }
        val safetyRatings = (map["safetyRatings"] as? List<*>)
            ?.mapNotNull { (it as? Map<*, *>)?.let(::decodeSafetyRating) }
            .orEmpty()
        val citationMetadata = (map["citationMetadata"] as? Map<*, *>)?.let(::decodeCitationMetadata)
        val finishReason = FinishReason.fromWire(map["finishReason"] as? String)
        val finishMessage = map["finishMessage"] as? String
        val index = (map["index"] as? Number)?.toInt() ?: defaultIndex
        return Candidate(
            content = content,
            safetyRatings = safetyRatings,
            citationMetadata = citationMetadata,
            finishReason = finishReason,
            finishMessage = finishMessage,
            index = index
        )
    }

    private fun decodeContent(map: Map<*, *>, defaultRole: String): Content {
        val role = (map["role"] as? String) ?: defaultRole
        val rawParts = map["parts"] as? List<*>
        val parsedParts = rawParts
            ?.mapNotNull { (it as? Map<*, *>)?.let(::decodePart) }
            .orEmpty()
        return Content(role = role, parts = parsedParts)
    }

    private fun decodePart(map: Map<*, *>): Part? {
        val isThought = map["thought"] == true
        val thoughtSignature = map["thoughtSignature"] as? String

        if (map.containsKey("text")) {
            val text = map["text"] as? String ?: ""
            return TextPart.createWithThinking(text, isThought, thoughtSignature)
        }
        val inlineMap = map["inlineData"] as? Map<*, *>
        if (inlineMap != null) {
            val mimeType = inlineMap["mimeType"] as? String ?: "application/octet-stream"
            val rawData = inlineMap["data"]
            if (rawData != null && rawData !is String) {
                throw SerializationException(
                    "Expected Base64 string in inlineData.data, got: ${rawData.javaClass.simpleName}"
                )
            }
            val bytes = decodeBase64Payload(rawData as? String ?: "")
            val displayName = inlineMap["displayName"] as? String
            return InlineDataPart.createWithThinking(
                bytes,
                mimeType,
                displayName,
                isThought,
                thoughtSignature
            )
        }
        val fileMap = map["fileData"] as? Map<*, *>
        if (fileMap != null) {
            val uri = fileMap["fileUri"] as? String ?: ""
            val mimeType = fileMap["mimeType"] as? String ?: "application/octet-stream"
            return FileDataPart.createWithThinking(uri, mimeType, isThought, thoughtSignature)
        }
        val fnCallMap = map["functionCall"] as? Map<*, *>
        if (fnCallMap != null) {
            val name = fnCallMap["name"] as? String
                ?: throw SerializationException("Missing functionCall.name in response part.")
            @Suppress("UNCHECKED_CAST")
            val args = (fnCallMap["args"] as? Map<String, Any?>)?.toMap().orEmpty()
            val id = fnCallMap["id"] as? String
            return FunctionCallPart.createWithThinking(name, args, id, isThought, thoughtSignature)
        }
        val fnResMap = map["functionResponse"] as? Map<*, *>
        if (fnResMap != null) {
            val name = fnResMap["name"] as? String ?: ""
            @Suppress("UNCHECKED_CAST")
            val responseObj = (fnResMap["response"] as? Map<String, Any?>)?.toMap().orEmpty()
            val id = fnResMap["id"] as? String
            val nestedParts = (fnResMap["parts"] as? List<*>)
                ?.mapNotNull { (it as? Map<*, *>)?.let(::decodePart) }
                .orEmpty()
            return FunctionResponsePart.createWithThinking(
                name,
                responseObj,
                id,
                nestedParts,
                isThought,
                thoughtSignature
            )
        }
        return null
    }

    private fun decodePromptFeedback(map: Map<*, *>): PromptFeedback {
        val blockReason = BlockReason.fromWire(map["blockReason"] as? String)
        val ratings = (map["safetyRatings"] as? List<*>)
            ?.mapNotNull { (it as? Map<*, *>)?.let(::decodeSafetyRating) }
            .orEmpty()
        val message = map["blockReasonMessage"] as? String
        return PromptFeedback(blockReason, ratings, message)
    }

    private fun decodeSafetyRating(map: Map<*, *>): SafetyRating? {
        val rawCategory = map["category"] as? String ?: return null
        val rawProbability = map["probability"] as? String ?: return null
        return SafetyRating(
            category = HarmCategory.fromWire(rawCategory),
            probability = HarmProbability.fromWire(rawProbability),
            probabilityScore = (map["probabilityScore"] as? Number)?.toFloat() ?: 0f,
            blocked = map["blocked"] as? Boolean,
            severity = (map["severity"] as? String)?.let(HarmSeverity::fromWire),
            severityScore = (map["severityScore"] as? Number)?.toFloat()
        )
    }

    private fun decodeCitationMetadata(map: Map<*, *>): CitationMetadata {
        val rawList = (map["citationSources"] as? List<*>) ?: (map["citations"] as? List<*>)
        val citations = rawList?.mapNotNull { item ->
            val cm = item as? Map<*, *> ?: return@mapNotNull null
            val endIndex = (cm["endIndex"] as? Number)?.toInt() ?: return@mapNotNull null
            val startIndex = (cm["startIndex"] as? Number)?.toInt() ?: 0
            val publicationDate = (cm["publicationDate"] as? Map<*, *>)?.let { dm ->
                Calendar.getInstance().apply {
                    val year = ((dm["year"] as? Number)?.toInt() ?: 1).coerceAtLeast(1)
                    val monthRaw = (dm["month"] as? Number)?.toInt() ?: 1
                    val month = if (monthRaw < 1) 0 else monthRaw - 1
                    val day = ((dm["day"] as? Number)?.toInt() ?: 1).coerceAtLeast(1)
                    set(year, month, day)
                }
            }
            Citation(
                title = cm["title"] as? String,
                startIndex = startIndex,
                endIndex = endIndex,
                uri = cm["uri"] as? String,
                license = cm["license"] as? String,
                publicationDate = publicationDate
            )
        }.orEmpty()
        return CitationMetadata(citations)
    }

    private fun decodeUsageMetadata(map: Map<*, *>): UsageMetadata = UsageMetadata(
        promptTokenCount = (map["promptTokenCount"] as? Number)?.toInt() ?: 0,
        candidatesTokenCount = (map["candidatesTokenCount"] as? Number)?.toInt() ?: 0,
        totalTokenCount = (map["totalTokenCount"] as? Number)?.toInt() ?: 0,
        cachedContentTokenCount = (map["cachedContentTokenCount"] as? Number)?.toInt() ?: 0,
        promptTokensDetails = decodeModalityDetails(map["promptTokensDetails"]),
        candidatesTokensDetails = decodeModalityDetails(map["candidatesTokensDetails"]),
        cacheTokensDetails = decodeModalityDetails(map["cacheTokensDetails"]),
        thoughtsTokenCount = (map["thoughtsTokenCount"] as? Number)?.toInt() ?: 0,
        toolUsePromptTokenCount = (map["toolUsePromptTokenCount"] as? Number)?.toInt() ?: 0,
        toolUsePromptTokensDetails = decodeModalityDetails(map["toolUsePromptTokensDetails"])
    )

    private fun decodeModalityDetails(raw: Any?): List<ModalityTokenCount> {
        val list = raw as? List<*> ?: return emptyList()
        return list.mapNotNull { entry ->
            val m = entry as? Map<*, *> ?: return@mapNotNull null
            val modality = ContentModality.fromWire(m["modality"] as? String)
            val count = (m["tokenCount"] as? Number)?.toInt() ?: 0
            ModalityTokenCount(modality, count)
        }
    }

    private fun decodeBase64Payload(raw: String): ByteArray {
        val stripped = StringBuilder(raw.length)
        for (ch in raw) {
            if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') continue
            when (ch) {
                '-' -> stripped.append('+')
                '_' -> stripped.append('/')
                else -> stripped.append(ch)
            }
        }
        if (stripped.isEmpty()) return ByteArray(0)
        val remainder = stripped.length % 4
        if (remainder == 1) {
            throw SerializationException("Malformed Base64 payload in inlineData part.")
        }
        if (remainder == 2) {
            stripped.append("==")
        } else if (remainder == 3) {
            stripped.append('=')
        }
        return try {
            Base64.getDecoder().decode(stripped.toString())
        } catch (e: IllegalArgumentException) {
            throw SerializationException("Malformed Base64 payload in inlineData part.", e)
        }
    }
}
