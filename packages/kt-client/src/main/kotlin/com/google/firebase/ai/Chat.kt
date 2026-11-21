package com.google.firebase.ai

import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.GenerateContentResponse
import com.google.firebase.ai.type.InvalidStateException
import com.google.firebase.ai.type.Part
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.TextPart
import com.google.firebase.ai.type.content
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Semaphore
import java.util.Collections

/**
 * Multi-turn conversational session backed by a [GenerativeModel].
 *
 * Maintains an internal conversation log exposed as immutable [history] snapshots. Turns that
 * fail, are blocked by safety filters, or are cancelled before stream completion are never
 * recorded in [history].
 */
class Chat @JvmOverloads constructor(
    private val model: GenerativeModel,
    history: List<Content> = emptyList()
) {
    private val historyLock = Any()
    private val activeRequestSemaphore = Semaphore(1)
    private val historyEntries = ArrayList<Content>(history.map(::normalizeSeedTurn))

    /**
     * Returns an immutable point-in-time snapshot of all completed turns in this conversation.
     */
    val history: List<Content>
        get() = synchronized(historyLock) {
            Collections.unmodifiableList(ArrayList(historyEntries))
        }

    /**
     * Sends [prompt] along with the prior [history] and records both user and model turns on
     * successful completion.
     */
    suspend fun sendMessage(prompt: Content): GenerateContentResponse {
        val normalizedPrompt = normalizeUserPrompt(prompt)
        acquireTurnSlot()
        try {
            val requestTurns = synchronized(historyLock) {
                val turns = ArrayList<Content>(historyEntries.size + 1)
                turns.addAll(historyEntries)
                turns.add(normalizedPrompt)
                turns
            }
            val response = model.generateContent(requestTurns)
            val candidateContent = response.candidates.firstOrNull()?.content
                ?: throw SerializationException("Chat response contained no candidates")
            val recordedModelTurn = Content(
                role = candidateContent.role?.takeIf { it.isNotBlank() } ?: "model",
                parts = candidateContent.parts
            )
            synchronized(historyLock) {
                historyEntries.add(normalizedPrompt)
                historyEntries.add(recordedModelTurn)
            }
            return response
        } finally {
            activeRequestSemaphore.release()
        }
    }

    /** Sends a plain text [prompt] in this conversation. */
    suspend fun sendMessage(prompt: String): GenerateContentResponse =
        sendMessage(content("user") { text(prompt) })

    /**
     * Streams the model's reply to [prompt], recording both the user turn and aggregated model
     * turn in [history] only if the stream completes normally without error, block, or early
     * cancellation.
     */
    fun sendMessageStream(prompt: Content): Flow<GenerateContentResponse> {
        val normalizedPrompt = normalizeUserPrompt(prompt)
        return flow {
            acquireTurnSlot()
            try {
                val requestTurns = synchronized(historyLock) {
                    val turns = ArrayList<Content>(historyEntries.size + 1)
                    turns.addAll(historyEntries)
                    turns.add(normalizedPrompt)
                    turns
                }
                val aggregatedParts = ArrayList<Part>()
                var modelRole = "model"
                var sawCandidate = false

                model.generateContentStream(requestTurns).collect { chunk ->
                    val firstCandidate = chunk.candidates.firstOrNull()
                    if (firstCandidate != null) {
                        sawCandidate = true
                        val chunkRole = firstCandidate.content.role
                        if (!chunkRole.isNullOrBlank()) {
                            modelRole = chunkRole
                        }
                        appendChunkParts(aggregatedParts, firstCandidate.content.parts)
                    }
                    emit(chunk)
                }

                if (!sawCandidate) {
                    throw SerializationException("Chat stream response contained no candidates")
                }

                val recordedModelTurn = Content(role = modelRole, parts = aggregatedParts)
                synchronized(historyLock) {
                    historyEntries.add(normalizedPrompt)
                    historyEntries.add(recordedModelTurn)
                }
            } finally {
                activeRequestSemaphore.release()
            }
        }
    }

    /** Streams the model's reply to a plain text [prompt] in this conversation. */
    fun sendMessageStream(prompt: String): Flow<GenerateContentResponse> =
        sendMessageStream(content("user") { text(prompt) })

    private fun acquireTurnSlot() {
        if (!activeRequestSemaphore.tryAcquire()) {
            throw InvalidStateException(
                "This chat instance currently has an ongoing request, please wait for it to complete before sending more messages"
            )
        }
    }

    companion object {
        private fun normalizeUserPrompt(prompt: Content): Content {
            val role = prompt.role
            if (role != null && role != "user" && role != "function") {
                throw InvalidStateException("Chat prompts should come from the 'user' role.")
            }
            return Content(role = "user", parts = prompt.parts)
        }

        private fun normalizeSeedTurn(turn: Content): Content {
            val normalizedRole = when (turn.role) {
                null, "function" -> "user"
                else -> turn.role
            }
            return Content(role = normalizedRole, parts = turn.parts)
        }

        private fun appendChunkParts(target: MutableList<Part>, incoming: List<Part>) {
            for (part in incoming) {
                if (
                    part is TextPart &&
                    part.text.isEmpty() &&
                    !part.isThought &&
                    part.thoughtSignature == null
                ) {
                    continue
                }
                val prev = target.lastOrNull()
                if (
                    part is TextPart &&
                    prev is TextPart &&
                    part.isThought == prev.isThought &&
                    prev.thoughtSignature == null
                ) {
                    target[target.lastIndex] = TextPart.createWithThinking(
                        text = prev.text + part.text,
                        isThought = part.isThought,
                        thoughtSignature = part.thoughtSignature
                    )
                } else {
                    target.add(part)
                }
            }
        }
    }
}
