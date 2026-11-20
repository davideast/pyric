package com.google.firebase.database

import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.auth.AuthLens
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.BridgeProtocol
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.database.internal.DatabaseInstanceResolver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap

class FirebaseDatabase(
    val bridgeClient: PyricBridgeClient,
    val app: FirebaseApp,
    val url: String = DEFAULT_DATABASE_URL,
    val credentialsProvider: CredentialsProvider? = null
) {
    internal val databaseScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var explicitAuthLens: AuthLens? = null

    private val _effectiveAuthLensFlow = MutableStateFlow(
        credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon
    )
    val authLensFlow: StateFlow<AuthLens> = _effectiveAuthLensFlow.asStateFlow()

    /** Off between goOffline() and goOnline(); `.info/connected` is false while it is off. */
    private val _networkEnabled = MutableStateFlow(true)
    internal val networkEnabled: StateFlow<Boolean> = _networkEnabled.asStateFlow()

    init {
        databaseScope.launch {
            credentialsProvider?.authLensFlow?.collect { lens ->
                if (explicitAuthLens == null) {
                    _effectiveAuthLensFlow.value = lens
                }
            }
        }
        databaseScope.launch {
            bridgeClient.remoteLensEvents.collect { lens ->
                _effectiveAuthLensFlow.value = lens
            }
        }
    }

    fun setAuthLens(lens: AuthLens?) {
        explicitAuthLens = lens
        _effectiveAuthLensFlow.value =
            lens ?: credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon
    }

    fun getEffectiveAuthLens(): AuthLens = _effectiveAuthLensFlow.value

    val reference: DatabaseReference
        get() = DatabaseReference(this, "")

    fun getReference(path: String): DatabaseReference {
        val cleanPath = path.trim('/')
        return DatabaseReference(this, cleanPath)
    }

    fun getReferenceFromUrl(fullUrl: String): DatabaseReference {
        val cleanBase = url.trimEnd('/')
        val path = if (fullUrl.startsWith(cleanBase)) {
            fullUrl.removePrefix(cleanBase).trim('/')
        } else {
            try {
                java.net.URI(fullUrl).path.trim('/')
            } catch (_: Throwable) {
                ""
            }
        }
        return DatabaseReference(this, path)
    }

    internal val wireInstance: String?
        get() {
            val effectiveUrl = if (url == DEFAULT_DATABASE_URL && !app.options.databaseUrl.isNullOrBlank()) {
                app.options.databaseUrl
            } else {
                url
            }
            return DatabaseInstanceResolver.resolveInstanceName(effectiveUrl, app.options.projectId)
        }

    internal fun withInstance(params: Map<String, Any?>): Map<String, Any?> =
        dev.pyric.database.attachWireInstance(params, wireInstance)

    fun goOffline() {
        _networkEnabled.value = false
        databaseScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                bridgeClient.op(
                    method = "rtdb.goOffline",
                    params = withInstance(emptyMap()),
                    actAs = getEffectiveAuthLens().toMap()
                )
            } catch (_: Exception) {}
        }
    }

    fun goOnline() {
        _networkEnabled.value = true
        databaseScope.launch(start = CoroutineStart.UNDISPATCHED) {
            try {
                bridgeClient.op(
                    method = "rtdb.goOnline",
                    params = withInstance(emptyMap()),
                    actAs = getEffectiveAuthLens().toMap()
                )
            } catch (_: Exception) {}
        }
    }

    companion object {
        const val DEFAULT_DATABASE_URL = "https://pyric-sandbox-default-rtdb.firebaseio.com"
        private val instances = ConcurrentHashMap<Pair<String, String>, FirebaseDatabase>()
        private val appBridgeClients = ConcurrentHashMap<String, PyricBridgeClient>()
        private val ownedFallbackBridges: MutableSet<PyricBridgeClient> =
            Collections.newSetFromMap(ConcurrentHashMap())

        private fun normalizeUrl(url: String): String =
            url.trim().trimEnd('/')

        private fun normalizeInstanceKey(app: FirebaseApp, url: String): Pair<String, String> =
            Pair(app.name, normalizeUrl(url))

        private fun resolveConfiguredAppUrl(app: FirebaseApp): String {
            val configured = app.options.databaseUrl?.let(::normalizeUrl)
            if (!configured.isNullOrEmpty()) return configured
            return DEFAULT_DATABASE_URL
        }

        private fun resolveDefaultBridgeUrl(): String {
            val prop = System.getProperty("pyric.bridge.url")?.trim()
            if (!prop.isNullOrEmpty()) return prop
            val liveEnv = System.getenv("PYRIC_LIVE_BRIDGE_URL")?.trim()
            if (!liveEnv.isNullOrEmpty()) return liveEnv
            val env = System.getenv("PYRIC_BRIDGE_URL")?.trim()
            if (!env.isNullOrEmpty()) return env
            return BridgeProtocol.DEFAULT_BRIDGE_URL
        }

        @JvmStatic
        fun getInstance(): FirebaseDatabase =
            getInstance(FirebaseApp.getInstance())

        @JvmStatic
        fun getInstance(url: String): FirebaseDatabase =
            getInstance(FirebaseApp.getInstance(), url)

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseDatabase =
            getInstance(app, resolveConfiguredAppUrl(app))

        @JvmStatic
        fun getInstance(app: FirebaseApp, url: String): FirebaseDatabase {
            val cleanUrl = normalizeUrl(url)
            return instances.computeIfAbsent(normalizeInstanceKey(app, cleanUrl)) {
                val cachedBridge = appBridgeClients[app.name]
                val configuredBridgeUrl = resolveDefaultBridgeUrl()
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
                FirebaseDatabase(bridge, app, cleanUrl, credentialsProvider = auth)
            }
        }

        @JvmStatic
        @JvmOverloads
        fun getInstance(
            app: FirebaseApp,
            bridgeClient: PyricBridgeClient,
            url: String = resolveConfiguredAppUrl(app),
            credentialsProvider: CredentialsProvider? = null
        ): FirebaseDatabase {
            val cleanUrl = normalizeUrl(url)
            return instances.computeIfAbsent(normalizeInstanceKey(app, cleanUrl)) {
                appBridgeClients.putIfAbsent(app.name, bridgeClient)
                val auth = credentialsProvider ?: runCatching {
                    FirebaseAuth.getInstance(app, bridgeClient)
                }.getOrNull()
                FirebaseDatabase(bridgeClient, app, cleanUrl, credentialsProvider = auth)
            }
        }

        @JvmStatic
        fun clearInstancesForTest() {
            for (db in instances.values) {
                db.databaseScope.cancel()
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
