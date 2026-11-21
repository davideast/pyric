package com.google.firebase.storage

import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.auth.AuthLens
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

/**
 * Entry point for Firebase Cloud Storage (`com.google.firebase.storage.FirebaseStorage`),
 * backed by the Pyric sandbox WebSocket bridge and optional HTTP byte route.
 */
class FirebaseStorage internal constructor(
    val app: FirebaseApp,
    val bridgeClient: PyricBridgeClient,
    internal val configuredBucket: String?,
    internal val defaultBucketName: String?,
    internal val usesNamedBucket: Boolean,
    val credentialsProvider: CredentialsProvider? = null
) {
    internal val storageScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @Volatile
    private var explicitAuthLens: AuthLens? = null

    private val _effectiveAuthLensFlow = MutableStateFlow(
        credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon
    )
    val authLensFlow: StateFlow<AuthLens> = _effectiveAuthLensFlow.asStateFlow()

    @Volatile
    var maxUploadRetryTimeMillis: Long = DEFAULT_MAX_UPLOAD_RETRY_MILLIS

    @Volatile
    var maxDownloadRetryTimeMillis: Long = DEFAULT_MAX_DOWNLOAD_RETRY_MILLIS

    @Volatile
    var maxOperationRetryTimeMillis: Long = DEFAULT_MAX_OPERATION_RETRY_MILLIS

    @Volatile
    var maxChunkUploadRetry: Long = DEFAULT_MAX_CHUNK_UPLOAD_RETRY_MILLIS

    @Volatile
    var emulatorHost: String? = null
        private set

    @Volatile
    var emulatorPort: Int? = null
        private set

    init {
        storageScope.launch {
            credentialsProvider?.authLensFlow?.collect { lens ->
                if (explicitAuthLens == null) {
                    _effectiveAuthLensFlow.value = lens
                }
            }
        }
        storageScope.launch {
            bridgeClient.remoteLensEvents.collect { lens ->
                _effectiveAuthLensFlow.value = lens
            }
        }
    }

    internal val bucket: String
        get() {
            val resolved = configuredBucket
            if (resolved.isNullOrEmpty()) {
                throw IllegalStateException("FirebaseApp was not initialized with a bucket name.")
            }
            return resolved
        }

    fun setAuthLens(lens: AuthLens?) {
        explicitAuthLens = lens
        _effectiveAuthLensFlow.value =
            lens ?: credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon
    }

    fun getEffectiveAuthLens(): AuthLens = _effectiveAuthLensFlow.value

    fun useEmulator(host: String, port: Int) {
        require(host.isNotBlank()) { "host must not be empty" }
        require(port in 1..65535) { "port must be between 1 and 65535" }
        emulatorHost = host.trim()
        emulatorPort = port
    }

    val reference: StorageReference
        get() {
            val activeBucket = configuredBucket
            if (activeBucket.isNullOrEmpty()) {
                throw IllegalStateException("FirebaseApp was not initialized with a bucket name.")
            }
            return StorageReference(this, "")
        }

    fun getReference(location: String): StorageReference {
        require(location.isNotEmpty()) { "location must not be null or empty" }
        if (StorageUrlParser.isUrlString(location)) {
            throw IllegalArgumentException("location should not be a full URL.")
        }
        return reference.child(location)
    }

    fun getReferenceFromUrl(fullUrl: String): StorageReference {
        val parsed = StorageUrlParser.parseFullStorageUrl(fullUrl)
        val instanceBucket = configuredBucket
        if (!instanceBucket.isNullOrEmpty() && !instanceBucket.equals(parsed.bucket, ignoreCase = true)) {
            throw IllegalArgumentException(
                "The supplied bucketname does not match the storage bucket of the current instance."
            )
        }
        if (instanceBucket.isNullOrEmpty()) {
            val customInstance = getInstance(app, "gs://${parsed.bucket}")
            return StorageReference(customInstance, parsed.wirePath)
        }
        return StorageReference(this, parsed.wirePath)
    }

    companion object {
        const val DEFAULT_SANDBOX_BUCKET: String = "pyric-default"
        const val DEFAULT_MAX_UPLOAD_RETRY_MILLIS: Long = 600_000L
        const val DEFAULT_MAX_DOWNLOAD_RETRY_MILLIS: Long = 600_000L
        const val DEFAULT_MAX_OPERATION_RETRY_MILLIS: Long = 120_000L
        const val DEFAULT_MAX_CHUNK_UPLOAD_RETRY_MILLIS: Long = 60_000L

        private data class InstanceKey(val appName: String, val bucketKey: String)

        private val instances = ConcurrentHashMap<InstanceKey, FirebaseStorage>()
        private val appBridgeClients = ConcurrentHashMap<String, PyricBridgeClient>()
        private val ownedFallbackBridges: MutableSet<PyricBridgeClient> =
            Collections.newSetFromMap(ConcurrentHashMap())

        private fun resolveAppDefaultBucket(app: FirebaseApp): String? {
            val rawOption = app.options.storageBucket
            if (rawOption != null) {
                val parsed = StorageUrlParser.parseConfiguredOptionBucket(rawOption)
                return parsed.takeIf { it.isNotEmpty() }
            }
            val projectId = app.options.projectId.trim()
            if (projectId.isNotEmpty()) {
                return "$projectId.appspot.com"
            }
            return null
        }

        private fun resolveBridgeUrl(): String {
            val sysProp = System.getProperty("pyric.storage.bridge.url")?.trim()
            if (!sysProp.isNullOrEmpty()) return sysProp
            val liveStorageEnv = System.getenv("PYRIC_LIVE_STORAGE_BRIDGE_URL")?.trim()
            if (!liveStorageEnv.isNullOrEmpty()) return liveStorageEnv
            return BridgeProtocol.resolveDefaultBridgeUrl()
        }

        @JvmStatic
        fun getInstance(): FirebaseStorage =
            getInstance(FirebaseApp.getInstance())

        @JvmStatic
        fun getInstance(url: String): FirebaseStorage =
            getInstance(FirebaseApp.getInstance(), url)

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseStorage {
            val defaultBucket = resolveAppDefaultBucket(app)
            return getOrCreateInstance(
                app = app,
                targetBucket = defaultBucket,
                defaultBucket = defaultBucket,
                usesNamedBucket = false,
                explicitBridge = null,
                explicitCredentials = null
            )
        }

        @JvmStatic
        fun getInstance(app: FirebaseApp, url: String): FirebaseStorage {
            val parsedBucket = StorageUrlParser.parseGsBucketInstanceUrl(url)
            val defaultBucket = resolveAppDefaultBucket(app)
            val isNamed = defaultBucket == null || !parsedBucket.equals(defaultBucket, ignoreCase = true)
            val canonicalBucket = if (!isNamed) defaultBucket ?: parsedBucket else parsedBucket
            return getOrCreateInstance(
                app = app,
                targetBucket = canonicalBucket,
                defaultBucket = defaultBucket,
                usesNamedBucket = isNamed,
                explicitBridge = null,
                explicitCredentials = null
            )
        }

        @JvmStatic
        @JvmOverloads
        fun getInstance(
            app: FirebaseApp,
            bridgeClient: PyricBridgeClient,
            url: String? = null,
            credentialsProvider: CredentialsProvider? = null
        ): FirebaseStorage {
            val defaultBucket = resolveAppDefaultBucket(app)
            val parsedBucket = url?.let { StorageUrlParser.parseGsBucketInstanceUrl(it) }
            val targetBucket = parsedBucket ?: defaultBucket
            val isNamed = parsedBucket != null &&
                (defaultBucket == null || !parsedBucket.equals(defaultBucket, ignoreCase = true))
            val canonicalBucket = if (!isNamed && defaultBucket != null) defaultBucket else targetBucket
            return getOrCreateInstance(
                app = app,
                targetBucket = canonicalBucket,
                defaultBucket = defaultBucket,
                usesNamedBucket = isNamed,
                explicitBridge = bridgeClient,
                explicitCredentials = credentialsProvider
            )
        }

        private fun getOrCreateInstance(
            app: FirebaseApp,
            targetBucket: String?,
            defaultBucket: String?,
            usesNamedBucket: Boolean,
            explicitBridge: PyricBridgeClient?,
            explicitCredentials: CredentialsProvider?
        ): FirebaseStorage {
            val bucketKey = (targetBucket ?: "<unconfigured>").lowercase()
            val key = InstanceKey(app.name, bucketKey)

            val existing = instances[key]
            if (existing != null && existing.app === app && !existing.bridgeClient.isDisposed) {
                return existing
            }
            if (existing != null) {
                instances.remove(key, existing)
                existing.storageScope.cancel()
            }

            return instances.computeIfAbsent(key) {
                val resolvedPair = resolveBridgeAndAuth(app, explicitBridge, explicitCredentials)
                FirebaseStorage(
                    app = app,
                    bridgeClient = resolvedPair.first,
                    configuredBucket = targetBucket,
                    defaultBucketName = defaultBucket,
                    usesNamedBucket = usesNamedBucket,
                    credentialsProvider = resolvedPair.second
                )
            }
        }

        private fun resolveBridgeAndAuth(
            app: FirebaseApp,
            explicitBridge: PyricBridgeClient?,
            explicitCredentials: CredentialsProvider?
        ): Pair<PyricBridgeClient, CredentialsProvider?> {
            if (explicitBridge != null) {
                appBridgeClients[app.name] = explicitBridge
                app.getOrCreateBridgeClient(explicitBridge)
                val auth = explicitCredentials ?: runCatching {
                    FirebaseAuth.getInstance(app, explicitBridge)
                }.getOrNull()
                return explicitBridge to auth
            }

            val cachedBridge = appBridgeClients[app.name]?.takeIf { !it.isDisposed }
            val configuredBridgeUrl = resolveBridgeUrl()
            val auth = runCatching {
                if (cachedBridge != null) {
                    FirebaseAuth.getInstance(app, cachedBridge)
                } else if (configuredBridgeUrl != BridgeProtocol.DEFAULT_BRIDGE_URL) {
                    val candidate = PyricBridgeClient(url = configuredBridgeUrl)
                    val resolvedAuth = FirebaseAuth.getInstance(app, candidate)
                    if (resolvedAuth.bridgeClient !== candidate) {
                        candidate.terminate()
                    } else {
                        ownedFallbackBridges.add(candidate)
                    }
                    resolvedAuth
                } else {
                    FirebaseAuth.getInstance(app)
                }
            }.getOrNull()

            val bridge = auth?.bridgeClient ?: appBridgeClients.computeIfAbsent(app.name) {
                PyricBridgeClient(url = configuredBridgeUrl).also { created ->
                    ownedFallbackBridges.add(created)
                }
            }
            appBridgeClients[app.name] = bridge
            app.getOrCreateBridgeClient(bridge)
            return bridge to (explicitCredentials ?: auth)
        }

        @JvmStatic
        fun clearInstancesForTest() {
            for (storage in instances.values) {
                storage.storageScope.cancel()
            }
            instances.clear()
            for (bridge in ownedFallbackBridges) {
                bridge.terminate()
            }
            ownedFallbackBridges.clear()
            appBridgeClients.clear()
        }
    }
}
