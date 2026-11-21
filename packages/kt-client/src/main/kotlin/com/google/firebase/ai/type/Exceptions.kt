package com.google.firebase.ai.type

/** Parent class for errors thrown by the Firebase AI SDK. */
abstract class FirebaseAIException internal constructor(
    message: String,
    cause: Throwable? = null
) : RuntimeException(message, cause)

/** Something went wrong while trying to serialize or deserialize a payload. */
class SerializationException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The server responded with a non-200 status code or wire error envelope. */
class ServerException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The provided API key is not valid. */
class InvalidAPIKeyException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/**
 * A prompt was blocked before content generation.
 *
 * Inspect [response] `promptFeedback.blockReason` for details when present.
 */
class PromptBlockedException internal constructor(
    val response: GenerateContentResponse?,
    cause: Throwable? = null,
    message: String? = null
) : FirebaseAIException(
    "Prompt was blocked: ${response?.promptFeedback?.blockReason?.name ?: message}",
    cause
) {
    internal constructor(message: String, cause: Throwable? = null) : this(null, cause, message)
}

/** Content was blocked by policy filters. */
class ContentBlockedException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The user's location (region) is not supported by the API. */
class UnsupportedUserLocationException internal constructor(
    cause: Throwable? = null
) : FirebaseAIException("User location is not supported for the API use.", cause)

/** The Firebase project has not been configured and enabled for the selected API. */
class APINotConfiguredException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** An invalid SDK or request configuration state occurred. */
class InvalidStateException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/**
 * Generation stopped early for a reason other than [FinishReason.STOP].
 *
 * @property response The full server response carrying candidates and finish metadata.
 */
class ResponseStoppedException internal constructor(
    val response: GenerateContentResponse,
    cause: Throwable? = null
) : FirebaseAIException(
    "Content generation stopped. Reason: ${response.candidates.firstOrNull()?.finishReason?.name}",
    cause
)

/** A request failed to complete within the configured timeout. */
class RequestTimeoutException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The specified cloud location is invalid. */
class InvalidLocationException internal constructor(
    location: String,
    cause: Throwable? = null
) : FirebaseAIException("Invalid location \"$location\"", cause)

/** The required backend service is disabled on this Firebase project. */
class ServiceDisabledException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The request exceeded an API rate limit or quota. */
class QuotaExceededException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** The request is missing a required permission. */
class PermissionMissingException(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)

/** Catch-all exception for unexpected failures. */
class UnknownException internal constructor(
    message: String,
    cause: Throwable? = null
) : FirebaseAIException(message, cause)
