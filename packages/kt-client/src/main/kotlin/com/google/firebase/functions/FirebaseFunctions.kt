package com.google.firebase.functions

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.await
import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.codecs.JsonCodec
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InterruptedIOException
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

class FirebaseFunctions internal constructor(
    val app: FirebaseApp,
    regionOrCustomDomain: String = FunctionsUrlResolver.DEFAULT_REGION,
    private val baseHttpClient: OkHttpClient = defaultHttpClient(),
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    internal val serializer = FunctionsSerializer()

    val region: String
    val customDomain: String?

    @Volatile
    private var emulatorOrigin: String? = null

    init {
        val parsed = FunctionsUrlResolver.parseRegionOrCustomDomain(regionOrCustomDomain)
        region = parsed.region
        customDomain = parsed.customDomain
    }

    fun useEmulator(host: String, port: Int) {
        emulatorOrigin = FunctionsUrlResolver.formatEmulatorOrigin(host, port)
    }

    @Deprecated("Use useEmulator(host, port) instead.")
    fun useFunctionsEmulator(origin: String) {
        emulatorOrigin = FunctionsUrlResolver.formatLegacyEmulatorOrigin(origin)
    }

    fun getHttpsCallable(name: String): HttpsCallableReference {
        return HttpsCallableReference(this, name, HttpsCallOptions())
    }

    fun getHttpsCallable(name: String, options: HttpsCallableOptions): HttpsCallableReference {
        return HttpsCallableReference(
            this,
            name,
            HttpsCallOptions(limitedUseAppCheckTokens = options.limitedUseAppCheckTokens)
        )
    }

    fun getHttpsCallableFromUrl(url: URL): HttpsCallableReference {
        return HttpsCallableReference(this, url, HttpsCallOptions())
    }

    fun getHttpsCallableFromUrl(url: URL, options: HttpsCallableOptions): HttpsCallableReference {
        return HttpsCallableReference(
            this,
            url,
            HttpsCallOptions(limitedUseAppCheckTokens = options.limitedUseAppCheckTokens)
        )
    }

    internal fun getURL(function: String): URL {
        val resolved = resolveNamedTarget(function)
        return URL(resolved.fetchUrl)
    }

    private fun currentGatewayOrigin(): String? =
        emulatorOrigin ?: FunctionsUrlResolver.resolveDefaultGatewayOrigin()

    private fun resolveNamedTarget(name: String): ResolvedCallableTarget {
        val projectId = app.options.projectId.orEmpty()
        return FunctionsUrlResolver.resolveNamedTarget(
            projectId = projectId,
            region = region,
            customDomain = customDomain,
            name = name,
            gatewayOrigin = currentGatewayOrigin()
        )
    }

    private fun resolveUrlTarget(url: URL): ResolvedCallableTarget {
        val projectId = app.options.projectId.orEmpty()
        return FunctionsUrlResolver.resolveUrlTarget(
            projectId = projectId,
            region = region,
            url = url,
            gatewayOrigin = currentGatewayOrigin()
        )
    }

    private suspend fun buildContextHeaders(limitedUseAppCheckTokens: Boolean): Map<String, String> {
        val headers = LinkedHashMap<String, String>()

        val authToken = resolveAuthIdToken()
        if (!authToken.isNullOrEmpty()) {
            headers["Authorization"] = "Bearer $authToken"
        }

        val appCheckToken = resolveAppCheckToken(limitedUseAppCheckTokens)
        if (!appCheckToken.isNullOrEmpty()) {
            headers["X-Firebase-AppCheck"] = appCheckToken
        }

        return headers
    }

    private suspend fun resolveAuthIdToken(): String? {
        val activeUser = runCatching { FirebaseAuth.getInstance(app).currentUser }.getOrNull()
            ?: return null
        return try {
            activeUser.getIdToken(false).await().token.takeIf { it.isNotEmpty() }
        } catch (_: Throwable) {
            null
        }
    }

    private suspend fun resolveAppCheckToken(limitedUse: Boolean): String? {
        val sharedProvider = app.appCheckTokenProvider ?: return null
        if (!limitedUse) {
            return sharedProvider.invoke()
        }
        return try {
            FirebaseAppCheck.getInstance(app).getLimitedUseAppCheckToken().await().token
        } catch (e: Throwable) {
            if (e.message == FirebaseAppCheck.NO_PROVIDER_INSTALLED_MESSAGE) {
                null
            } else {
                FirebaseAppCheck.APP_CHECK_PLACEHOLDER_TOKEN
            }
        }
    }

    internal fun call(
        name: String,
        data: Any?,
        options: HttpsCallOptions
    ): Task<HttpsCallableResult> = executeCall({ resolveNamedTarget(name) }, data, options)

    internal fun call(
        url: URL,
        data: Any?,
        options: HttpsCallOptions
    ): Task<HttpsCallableResult> = executeCall({ resolveUrlTarget(url) }, data, options)

    private fun executeCall(
        resolveTarget: () -> ResolvedCallableTarget,
        data: Any?,
        options: HttpsCallOptions
    ): Task<HttpsCallableResult> {
        val tcs = TaskCompletionSource<HttpsCallableResult>()
        val encodedData = try {
            serializer.encode(data)
        } catch (e: Exception) {
            tcs.setException(e)
            return tcs.task
        }
        val target = try {
            resolveTarget()
        } catch (e: Exception) {
            tcs.setException(e)
            return tcs.task
        }

        val payloadJson = JsonCodec.encodeToString(mapOf("data" to encodedData))
        val timeoutMs = options.getTimeout()

        scope.launch {
            try {
                val headers = buildContextHeaders(options.limitedUseAppCheckTokens)
                val reqBuilder = Request.Builder()
                    .url(target.fetchUrl)
                    .post(payloadJson.toRequestBody(JSON_MEDIA_TYPE))
                for ((k, v) in headers) {
                    reqBuilder.header(k, v)
                }

                val callClient = baseHttpClient.newBuilder()
                    .callTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build()

                val result = callClient.newCall(reqBuilder.build()).execute().use { response ->
                    val rawBody = response.body?.string()
                    val statusCode = FirebaseFunctionsException.Code.fromHttpStatus(response.code)
                    val responseErr = FirebaseFunctionsException.fromResponse(
                        defaultCode = statusCode,
                        body = rawBody,
                        serializer = serializer
                    )
                    if (responseErr != null) {
                        throw responseErr
                    }
                    if (rawBody.isNullOrBlank()) {
                        throw FirebaseFunctionsException(
                            "Response is missing data field.",
                            FirebaseFunctionsException.Code.INTERNAL,
                            null
                        )
                    }
                    val parsed = runCatching { JsonCodec.decode(rawBody) as? Map<*, *> }.getOrNull()
                        ?: throw FirebaseFunctionsException(
                            "Response is not valid JSON.",
                            FirebaseFunctionsException.Code.INTERNAL,
                            null
                        )
                    val hasData = parsed.containsKey("data")
                    val hasResult = parsed.containsKey("result")
                    if (!hasData && !hasResult) {
                        throw FirebaseFunctionsException(
                            "Response is missing data field.",
                            FirebaseFunctionsException.Code.INTERNAL,
                            null
                        )
                    }
                    val rawResult = if (hasData) parsed["data"] else parsed["result"]
                    HttpsCallableResult(serializer.decode(rawResult))
                }
                tcs.setResult(result)
            } catch (e: FirebaseFunctionsException) {
                tcs.setException(e)
            } catch (e: InterruptedIOException) {
                tcs.setException(
                    FirebaseFunctionsException(
                        "DEADLINE_EXCEEDED",
                        FirebaseFunctionsException.Code.DEADLINE_EXCEEDED,
                        null,
                        e
                    )
                )
            } catch (e: IOException) {
                tcs.setException(
                    FirebaseFunctionsException(
                        "INTERNAL",
                        FirebaseFunctionsException.Code.INTERNAL,
                        null,
                        e
                    )
                )
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    internal fun stream(
        name: String,
        data: Any?,
        options: HttpsCallOptions
    ): Flow<StreamResponse> = executeStream({ resolveNamedTarget(name) }, data, options)

    internal fun stream(
        url: URL,
        data: Any?,
        options: HttpsCallOptions
    ): Flow<StreamResponse> = executeStream({ resolveUrlTarget(url) }, data, options)

    private fun executeStream(
        resolveTarget: () -> ResolvedCallableTarget,
        data: Any?,
        options: HttpsCallOptions
    ): Flow<StreamResponse> = callbackFlow {
        val encodedData = serializer.encode(data)
        val target = resolveTarget()
        val payloadJson = JsonCodec.encodeToString(mapOf("data" to encodedData))
        val headers = buildContextHeaders(options.limitedUseAppCheckTokens)

        val reqBuilder = Request.Builder()
            .url(target.fetchUrl)
            .post(payloadJson.toRequestBody(JSON_MEDIA_TYPE))
            .header("Accept", "text/event-stream")
        for ((k, v) in headers) {
            reqBuilder.header(k, v)
        }

        val streamClient = baseHttpClient.newBuilder()
            .callTimeout(0L, TimeUnit.MILLISECONDS)
            .readTimeout(0L, TimeUnit.MILLISECONDS)
            .connectTimeout(options.getTimeout(), TimeUnit.MILLISECONDS)
            .writeTimeout(options.getTimeout(), TimeUnit.MILLISECONDS)
            .build()

        val httpCall = streamClient.newCall(reqBuilder.build())
        val workerJob = launch(dispatcher) {
            try {
                httpCall.execute().use { response ->
                    if (response.code !in 200..299) {
                        val errBody = response.body?.string()
                        val code = FirebaseFunctionsException.Code.fromHttpStatus(response.code)
                        val mapped = FirebaseFunctionsException.fromResponse(code, errBody, serializer)
                            ?: FirebaseFunctionsException(code.name, code, null)
                        close(mapped)
                        return@use
                    }
                    val body = response.body
                    if (body == null) {
                        close(
                            FirebaseFunctionsException(
                                "Response body is missing.",
                                FirebaseFunctionsException.Code.INTERNAL,
                                null
                            )
                        )
                        return@use
                    }
                    body.charStream().buffered().use { reader ->
                        while (isActive) {
                            val rawLine = reader.readLine() ?: break
                            val trimmed = rawLine.trim()
                            if (!trimmed.startsWith("data:")) {
                                continue
                            }
                            val jsonPart = trimmed.removePrefix("data:").trim()
                            if (jsonPart.isEmpty()) {
                                continue
                            }
                            val parsed = runCatching { JsonCodec.decode(jsonPart) as? Map<*, *> }.getOrNull()
                                ?: continue
                            if (parsed.containsKey("error")) {
                                val streamErr = FirebaseFunctionsException.fromParsedErrorEnvelope(
                                    defaultCode = FirebaseFunctionsException.Code.INTERNAL,
                                    parsedBody = parsed,
                                    serializer = serializer
                                ) ?: FirebaseFunctionsException(
                                    "INTERNAL",
                                    FirebaseFunctionsException.Code.INTERNAL,
                                    null
                                )
                                close(streamErr)
                                return@use
                            }
                            if (parsed.containsKey("message")) {
                                val decodedChunk = serializer.decode(parsed["message"])
                                trySend(StreamResponse.Message(HttpsCallableResult(decodedChunk)))
                            }
                            if (parsed.containsKey("result")) {
                                val decodedFinal = serializer.decode(parsed["result"])
                                trySend(StreamResponse.Result(HttpsCallableResult(decodedFinal)))
                            }
                        }
                    }
                }
                close()
            } catch (e: FirebaseFunctionsException) {
                close(e)
            } catch (e: InterruptedIOException) {
                if (isActive && !httpCall.isCanceled()) {
                    close(
                        FirebaseFunctionsException(
                            "DEADLINE_EXCEEDED",
                            FirebaseFunctionsException.Code.DEADLINE_EXCEEDED,
                            null,
                            e
                        )
                    )
                } else {
                    close()
                }
            } catch (e: IOException) {
                if (isActive && !httpCall.isCanceled()) {
                    close(
                        FirebaseFunctionsException(
                            "INTERNAL",
                            FirebaseFunctionsException.Code.INTERNAL,
                            null,
                            e
                        )
                    )
                } else {
                    close()
                }
            } catch (e: Throwable) {
                close(e)
            }
        }

        awaitClose {
            httpCall.cancel()
            workerJob.cancel()
        }
    }.flowOn(dispatcher)

    internal fun dispose() {
        scope.cancel()
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val instances = ConcurrentHashMap<String, FirebaseFunctions>()
        private val sharedHttpClient = OkHttpClient()

        private fun defaultHttpClient(): OkHttpClient = sharedHttpClient

        private fun instanceKey(app: FirebaseApp, regionOrCustomDomain: String): String =
            "${app.name}::${regionOrCustomDomain.trim().ifEmpty { FunctionsUrlResolver.DEFAULT_REGION }}"

        @JvmStatic
        fun getInstance(): FirebaseFunctions =
            getInstance(FirebaseApp.getInstance(), FunctionsUrlResolver.DEFAULT_REGION)

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseFunctions =
            getInstance(app, FunctionsUrlResolver.DEFAULT_REGION)

        @JvmStatic
        fun getInstance(regionOrCustomDomain: String): FirebaseFunctions =
            getInstance(FirebaseApp.getInstance(), regionOrCustomDomain)

        @JvmStatic
        fun getInstance(app: FirebaseApp, regionOrCustomDomain: String): FirebaseFunctions {
            val key = instanceKey(app, regionOrCustomDomain)
            return instances.computeIfAbsent(key) {
                FirebaseFunctions(app = app, regionOrCustomDomain = regionOrCustomDomain)
            }
        }

        @JvmStatic
        fun clearInstancesForTest() {
            for (fn in instances.values) {
                fn.dispose()
            }
            instances.clear()
        }
    }
}
