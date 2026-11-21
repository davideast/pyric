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
            val wireCode = error.wireCode ?: ""
            if (
                error.code == FirebaseFirestoreException.Code.DEADLINE_EXCEEDED ||
                wireCode.equals("ai/DEADLINE_EXCEEDED", ignoreCase = true) ||
                wireCode.equals("deadline-exceeded", ignoreCase = true)
            ) {
                return RequestTimeoutException(message, error)
            }
            if (
                message.contains("API key not valid", ignoreCase = true) ||
                message.contains("API_KEY_INVALID", ignoreCase = true)
            ) {
                return InvalidAPIKeyException(message, error)
            }
            if (message == "User location is not supported for the API use.") {
                return UnsupportedUserLocationException(error)
            }
            if (
                wireCode.equals("ai/RESOURCE_EXHAUSTED", ignoreCase = true) ||
                error.code == FirebaseFirestoreException.Code.RESOURCE_EXHAUSTED ||
                message.contains("quota", ignoreCase = true)
            ) {
                return QuotaExceededException(message, error)
            }
            if (message.contains("The prompt could not be submitted")) {
                return PromptBlockedException(message, error)
            }
            if (message.contains("genai config not found", ignoreCase = true)) {
                return APINotConfiguredException(message, error)
            }
            if (message.contains("SERVICE_DISABLED", ignoreCase = true)) {
                return ServiceDisabledException(message, error)
            }
            return ServerException(message, error)
        }
        return UnknownException(error.message ?: "Something unexpected happened.", error)
    }
}
