package com.google.firebase.ai

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.ai.type.Content
import com.google.firebase.ai.type.GenerationConfig
import com.google.firebase.ai.type.GenerativeBackend as TypeGenerativeBackend
import com.google.firebase.ai.type.InferenceSource as TypeInferenceSource
import com.google.firebase.ai.type.RequestOptions
import com.google.firebase.ai.type.SafetySetting
import com.google.firebase.app
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.PyricBridgeClient
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/** Package-level alias so both `com.google.firebase.ai.type.GenerativeBackend` and `com.google.firebase.ai.GenerativeBackend` resolve. */
typealias GenerativeBackend = TypeGenerativeBackend

/** Package-level alias so both `com.google.firebase.ai.InferenceSource` and `com.google.firebase.ai.type.InferenceSource` resolve. */
typealias InferenceSource = TypeInferenceSource

/** Entry point for Firebase AI Logic (`com.google.firebase.ai`). */
class FirebaseAI internal constructor(
    val app: FirebaseApp,
    val backend: TypeGenerativeBackend,
    val useLimitedUseAppCheckTokens: Boolean = false,
    private val explicitBridgeClient: PyricBridgeClient? = null
) {
    init {
        if (explicitBridgeClient != null) {
            app.getOrCreateBridgeClient(explicitBridgeClient)
        }
    }

    internal val bridgeClient: PyricBridgeClient
        get() = resolveBridge(app, explicitBridgeClient)
    /** Instantiates a [GenerativeModel] configured against this [FirebaseAI] backend. */
    @JvmOverloads
    fun generativeModel(
        modelName: String,
        generationConfig: GenerationConfig? = null,
        safetySettings: List<SafetySetting>? = null,
        systemInstruction: Content? = null,
        requestOptions: RequestOptions = RequestOptions()
    ): GenerativeModel {
        val normalized = backend.normalizeModelResource(modelName)
        return GenerativeModel(
            firebaseAI = this,
            modelName = modelName,
            normalizedModelName = normalized,
            generationConfig = generationConfig,
            safetySettings = safetySettings?.toList(),
            systemInstruction = systemInstruction,
            requestOptions = requestOptions
        )
    }

    companion object {
        private data class InstanceKey(
            val appName: String,
            val backend: TypeGenerativeBackend,
            val useLimitedUseAppCheckTokens: Boolean
        )

        private val instances = ConcurrentHashMap<InstanceKey, FirebaseAI>()
        private val appBridgeClients = ConcurrentHashMap<String, PyricBridgeClient>()
        private val ownedBridges: MutableSet<PyricBridgeClient> =
            Collections.newSetFromMap(ConcurrentHashMap())

        /** Default [FirebaseAI] instance for [FirebaseApp.getInstance] using [TypeGenerativeBackend.googleAI]. */
        @get:JvmName("defaultInstance")
        val instance: FirebaseAI
            get() = getInstance()

        /** Returns the [FirebaseAI] instance for the default [FirebaseApp] and Google AI backend. */
        @JvmStatic
        fun getInstance(): FirebaseAI =
            getInstance(FirebaseApp.getInstance(), TypeGenerativeBackend.googleAI(), false)

        /** Returns the [FirebaseAI] instance for [app] using the Google AI backend. */
        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseAI =
            getInstance(app, TypeGenerativeBackend.googleAI(), false)

        /** Returns the [FirebaseAI] instance for [backend] on [app]. */
        @JvmStatic
        fun getInstance(backend: TypeGenerativeBackend): FirebaseAI =
            getInstance(FirebaseApp.getInstance(), backend, false)

        /** Returns the [FirebaseAI] instance for [app] and [backend]. */
        @JvmStatic
        fun getInstance(app: FirebaseApp, backend: TypeGenerativeBackend): FirebaseAI =
            getInstance(app, backend, false)

        /** Returns the [FirebaseAI] instance for [app], [backend], and [useLimitedUseAppCheckTokens]. */
        @JvmStatic
        fun getInstance(
            app: FirebaseApp,
            backend: TypeGenerativeBackend,
            useLimitedUseAppCheckTokens: Boolean
        ): FirebaseAI = getOrCreateInstance(
            app = app,
            backend = backend,
            useLimitedUseAppCheckTokens = useLimitedUseAppCheckTokens,
            explicitBridge = null
        )

        /** Returns or binds a [FirebaseAI] instance using an explicit [PyricBridgeClient]. */
        @JvmStatic
        @JvmOverloads
        fun getInstance(
            app: FirebaseApp = FirebaseApp.getInstance(),
            bridgeClient: PyricBridgeClient,
            backend: TypeGenerativeBackend = TypeGenerativeBackend.googleAI(),
            useLimitedUseAppCheckTokens: Boolean = false
        ): FirebaseAI = getOrCreateInstance(
            app = app,
            backend = backend,
            useLimitedUseAppCheckTokens = useLimitedUseAppCheckTokens,
            explicitBridge = bridgeClient
        )

        private fun resolveConfiguredBridgeUrl(): String {
            val sysProp = System.getProperty("pyric.ai.bridge.url")?.trim()
            if (!sysProp.isNullOrEmpty()) return sysProp
            val liveAiEnv = System.getenv("PYRIC_LIVE_AI_BRIDGE_URL")?.trim()
            if (!liveAiEnv.isNullOrEmpty()) return liveAiEnv
            return BridgeProtocol.resolveDefaultBridgeUrl()
        }

        private fun resolveBridge(
            app: FirebaseApp,
            explicitBridge: PyricBridgeClient?
        ): PyricBridgeClient {
            if (explicitBridge != null) {
                appBridgeClients[app.name] = explicitBridge
                return app.getOrCreateBridgeClient(explicitBridge)
            }
            val cached = appBridgeClients[app.name]?.takeIf { !it.isDisposed }
            if (cached != null) {
                return app.getOrCreateBridgeClient(cached)
            }
            val configuredUrl = resolveConfiguredBridgeUrl()
            if (configuredUrl != BridgeProtocol.DEFAULT_BRIDGE_URL) {
                val created = PyricBridgeClient(url = configuredUrl)
                ownedBridges.add(created)
                val bound = app.getOrCreateBridgeClient(created)
                appBridgeClients[app.name] = bound
                return bound
            }
            val shared = app.getOrCreateBridgeClient()
            appBridgeClients[app.name] = shared
            return shared
        }

        private fun getOrCreateInstance(
            app: FirebaseApp,
            backend: TypeGenerativeBackend,
            useLimitedUseAppCheckTokens: Boolean,
            explicitBridge: PyricBridgeClient?
        ): FirebaseAI {
            val key = InstanceKey(app.name, backend, useLimitedUseAppCheckTokens)
            val existing = instances[key]
            val matchesBridge = explicitBridge == null || existing?.explicitBridgeClient === explicitBridge
            val isDisposed = existing?.explicitBridgeClient?.isDisposed == true
            if (
                existing != null &&
                existing.app === app &&
                !isDisposed &&
                matchesBridge
            ) {
                return existing
            }
            if (existing != null) {
                instances.remove(key, existing)
            }
            return instances.computeIfAbsent(key) {
                if (explicitBridge != null) {
                    appBridgeClients[app.name] = explicitBridge
                }
                FirebaseAI(
                    app = app,
                    backend = backend,
                    useLimitedUseAppCheckTokens = useLimitedUseAppCheckTokens,
                    explicitBridgeClient = explicitBridge
                )
            }
        }

        /** Clears cached [FirebaseAI] instances and terminates any standalone bridges created here. */
        @JvmStatic
        fun reset() {
            instances.clear()
            for (bridge in ownedBridges) {
                runCatching { bridge.terminate() }
            }
            ownedBridges.clear()
            appBridgeClients.clear()
        }

        /** Alias matching other `packages/kt-client` services for test teardown. */
        @JvmStatic
        fun clearInstancesForTest() = reset()
    }
}

/** Default [FirebaseAI] instance for [Firebase.app] using [TypeGenerativeBackend.googleAI]. */
val Firebase.ai: FirebaseAI
    get() = FirebaseAI.instance

/** Returns the [FirebaseAI] instance for [app] and [backend]. */
fun Firebase.ai(
    app: FirebaseApp = Firebase.app,
    backend: TypeGenerativeBackend = TypeGenerativeBackend.googleAI()
): FirebaseAI = FirebaseAI.getInstance(app, backend)

/** Returns the [FirebaseAI] instance for [app], [backend], and [useLimitedUseAppCheckTokens]. */
fun Firebase.ai(
    app: FirebaseApp = Firebase.app,
    backend: TypeGenerativeBackend = TypeGenerativeBackend.googleAI(),
    useLimitedUseAppCheckTokens: Boolean
): FirebaseAI = FirebaseAI.getInstance(app, backend, useLimitedUseAppCheckTokens)
