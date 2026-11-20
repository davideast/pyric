package dev.pyric.appcheck

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckToken
import com.google.firebase.appcheck.DefaultAppCheckToken
import com.google.firebase.appcheck.FirebaseAppCheck
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

internal class BridgeAppCheckProvider(
    private val app: FirebaseApp,
    internal val providerKind: String,
    dispatcher: CoroutineDispatcher = Dispatchers.IO
) : AppCheckProvider {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private fun resolveBridge(): PyricBridgeClient =
        FirebaseAppCheck.resolveBridgeClient(app)

    private fun baseParams(): Map<String, Any?> {
        val params = mutableMapOf<String, Any?>(
            "provider" to providerKind
        )
        if (app.options.applicationId.isNotEmpty()) {
            params["appId"] = app.options.applicationId
        }
        if (app.options.projectId.isNotEmpty()) {
            params["projectId"] = app.options.projectId
        }
        return params
    }

    override fun getToken(): Task<AppCheckToken> {
        val tcs = TaskCompletionSource<AppCheckToken>()
        scope.launch {
            try {
                tcs.setResult(fetchToken(forceRefresh = true))
            } catch (e: Throwable) {
                tcs.setException(toFirebaseException(e))
            }
        }
        return tcs.task
    }

    internal suspend fun fetchToken(forceRefresh: Boolean): AppCheckToken {
        val params = baseParams().toMutableMap()
        params["forceRefresh"] = forceRefresh
        val raw = resolveBridge().op(
            method = "appCheck.getToken",
            params = params
        )
        return decodeAppCheckToken(raw)
    }

    internal suspend fun fetchLimitedUseToken(): AppCheckToken {
        val raw = resolveBridge().op(
            method = "appCheck.getLimitedUseToken",
            params = baseParams()
        )
        return decodeAppCheckToken(raw)
    }

    private fun decodeAppCheckToken(raw: Any?): AppCheckToken {
        @Suppress("UNCHECKED_CAST")
        val map = raw as? Map<String, Any?>
            ?: throw FirebaseException("App Check response from Pyric bridge was not an object.")
        val token = map["token"] as? String
        if (token.isNullOrEmpty()) {
            throw FirebaseException("App Check response from Pyric bridge lacked a non-empty token.")
        }
        val expireRaw = map["expireTimeMillis"]
        val expireTimeMillis = when (expireRaw) {
            is Number -> expireRaw.toLong()
            else -> System.currentTimeMillis() + DEFAULT_TTL_MILLIS
        }
        return DefaultAppCheckToken(token = token, expireTimeMillis = expireTimeMillis)
    }

    companion object {
        private const val DEFAULT_TTL_MILLIS = 3_600_000L

        internal fun toFirebaseException(error: Throwable): Exception {
            if (error is FirebaseException) {
                return error
            }
            val detail = error.message
            if (!detail.isNullOrEmpty()) {
                return FirebaseException(detail, error)
            }
            return FirebaseException("App Check token request failed.", error)
        }
    }
}
