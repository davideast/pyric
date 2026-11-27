package com.google.firebase.ai.internal

import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.ai.type.APINotConfiguredException
import com.google.firebase.ai.type.FirebaseAIException
import com.google.firebase.ai.type.InvalidAPIKeyException
import com.google.firebase.ai.type.PromptBlockedException
import com.google.firebase.ai.type.QuotaExceededException
import com.google.firebase.ai.type.RequestTimeoutException
import com.google.firebase.ai.type.SerializationException
import com.google.firebase.ai.type.ServerException
import com.google.firebase.ai.type.ServiceDisabledException
import com.google.firebase.ai.type.UnknownException
import com.google.firebase.ai.type.UnsupportedUserLocationException
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.firestore.FirebaseFirestoreException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException

internal data class AiAppCheckClaim(val token: String)

internal object AiBridgeCallPolicy {

    suspend fun resolveAppCheckClaim(
        app: FirebaseApp,
        useLimitedUseTokens: Boolean
    ): AiAppCheckClaim? {
        val provider = app.appCheckTokenProvider ?: return null
        if (!useLimitedUseTokens) {
            val token = try {
                provider.invoke()
            } catch (_: Throwable) {
                FirebaseAppCheck.APP_CHECK_PLACEHOLDER_TOKEN
            } ?: return null
            return AiAppCheckClaim(token)
        }

        return try {
            val minted = FirebaseAppCheck.getInstance(app).getLimitedUseAppCheckToken().await()
            AiAppCheckClaim(minted.token)
        } catch (e: FirebaseException) {
            if (e.message == FirebaseAppCheck.NO_PROVIDER_INSTALLED_MESSAGE) {
                null
            } else {
                AiAppCheckClaim(FirebaseAppCheck.APP_CHECK_PLACEHOLDER_TOKEN)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            AiAppCheckClaim(FirebaseAppCheck.APP_CHECK_PLACEHOLDER_TOKEN)
        }
    }

    fun mapBridgeException(error: Throwable): FirebaseAIException {
        if (error is TimeoutCancellationException) {
            return RequestTimeoutException(
                error.message ?: "The request failed to complete in the allotted time.",
                error
            )
        }
        if (error is CancellationException) {
            throw error
        }
        if (error is FirebaseAIException) {
            return error
        }
        if (error is FirebaseFirestoreException) {
            val message = error.message ?: "Unknown AI backend error"
            val wireCode = error.wireCode ?: error.code.name
            return classifyWireError(wireCode, message, error.aiEnvelope, error)
        }
        return UnknownException(error.message ?: "Something unexpected happened.", error)
    }

    fun mapStreamError(
        code: String,
        message: String,
        aiEnvelope: Map<String, Any?>?,
        cause: Throwable?
    ): FirebaseAIException {
        if (cause is CancellationException && cause !is TimeoutCancellationException) {
            throw cause
        }
        if (cause is FirebaseAIException) {
            return cause
        }
        return classifyWireError(code, message, aiEnvelope, cause)
    }

    private fun classifyWireError(
        code: String,
        message: String,
        aiEnvelope: Map<String, Any?>?,
        cause: Throwable?
    ): FirebaseAIException {
        val envelopeError = aiEnvelope?.get("error") as? Map<*, *>
        val envelopeStatus = (envelopeError?.get("status") as? String) ?: ""
        val effectiveMessage = (envelopeError?.get("message") as? String)
            ?.takeIf { it.isNotBlank() }
            ?: message

        if (code.equals("SERIALIZATION_ERROR", ignoreCase = true)) {
            return SerializationException(effectiveMessage, cause)
        }
        if (
            code.equals("DEADLINE_EXCEEDED", ignoreCase = true) ||
            code.equals("ai/DEADLINE_EXCEEDED", ignoreCase = true) ||
            code.equals("deadline-exceeded", ignoreCase = true) ||
            envelopeStatus.equals("DEADLINE_EXCEEDED", ignoreCase = true)
        ) {
            return RequestTimeoutException(effectiveMessage, cause)
        }

        val detailReasons = (envelopeError?.get("details") as? List<*>)
            ?.mapNotNull { (it as? Map<*, *>)?.get("reason") as? String }
            .orEmpty()

        if (
            effectiveMessage.contains("API key not valid", ignoreCase = true) ||
            effectiveMessage.contains("API_KEY_INVALID", ignoreCase = true) ||
            detailReasons.any { it.equals("API_KEY_INVALID", ignoreCase = true) }
        ) {
            return InvalidAPIKeyException(effectiveMessage, cause)
        }
        if (effectiveMessage == "User location is not supported for the API use.") {
            return UnsupportedUserLocationException(cause)
        }
        if (
            code.equals("ai/RESOURCE_EXHAUSTED", ignoreCase = true) ||
            code.equals("RESOURCE_EXHAUSTED", ignoreCase = true) ||
            code.equals("resource-exhausted", ignoreCase = true) ||
            envelopeStatus.equals("RESOURCE_EXHAUSTED", ignoreCase = true) ||
            effectiveMessage.contains("quota", ignoreCase = true)
        ) {
            return QuotaExceededException(effectiveMessage, cause)
        }
        if (effectiveMessage.contains("The prompt could not be submitted")) {
            return PromptBlockedException(effectiveMessage, cause)
        }
        if (effectiveMessage.contains("genai config not found", ignoreCase = true)) {
            return APINotConfiguredException(effectiveMessage, cause)
        }
        if (
            effectiveMessage.contains("SERVICE_DISABLED", ignoreCase = true) ||
            detailReasons.any { it.equals("SERVICE_DISABLED", ignoreCase = true) }
        ) {
            return ServiceDisabledException(effectiveMessage, cause)
        }
        return ServerException(effectiveMessage, cause)
    }
}
