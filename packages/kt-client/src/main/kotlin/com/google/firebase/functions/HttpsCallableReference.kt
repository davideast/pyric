package com.google.firebase.functions

import com.google.android.gms.tasks.Task
import kotlinx.coroutines.flow.Flow
import java.net.URL
import java.util.concurrent.TimeUnit

class HttpsCallableReference private constructor(
    private val functionsClient: FirebaseFunctions,
    private val name: String?,
    private val url: URL?,
    internal val options: HttpsCallOptions
) {
    internal constructor(
        functionsClient: FirebaseFunctions,
        name: String,
        options: HttpsCallOptions
    ) : this(functionsClient = functionsClient, name = name, url = null, options = options)

    internal constructor(
        functionsClient: FirebaseFunctions,
        url: URL,
        options: HttpsCallOptions
    ) : this(functionsClient = functionsClient, name = null, url = url, options = options)

    fun call(): Task<HttpsCallableResult> = call(null)

    fun call(data: Any?): Task<HttpsCallableResult> {
        val targetName = name
        if (targetName != null) {
            return functionsClient.call(targetName, data, options)
        }
        val targetUrl = requireNotNull(url) { "Required callable URL was null." }
        return functionsClient.call(targetUrl, data, options)
    }

    @JvmOverloads
    fun stream(data: Any? = null): Flow<StreamResponse> {
        val targetName = name
        if (targetName != null) {
            return functionsClient.stream(targetName, data, options)
        }
        val targetUrl = requireNotNull(url) { "Required callable URL was null." }
        return functionsClient.stream(targetUrl, data, options)
    }

    fun setTimeout(timeout: Long, units: TimeUnit) {
        options.setTimeout(timeout, units)
    }

    fun getTimeout(): Long = options.getTimeout()

    fun withTimeout(timeout: Long, units: TimeUnit): HttpsCallableReference {
        return HttpsCallableReference(
            functionsClient = functionsClient,
            name = name,
            url = url,
            options = options.copyWithTimeout(timeout, units)
        )
    }
}
