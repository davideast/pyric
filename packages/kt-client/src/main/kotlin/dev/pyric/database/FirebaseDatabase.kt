package dev.pyric.database

import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.auth.AuthLens
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class FirebaseDatabase(
    val bridgeClient: PyricBridgeClient,
    val app: FirebaseApp,
    val url: String = DEFAULT_DATABASE_URL,
    val credentialsProvider: CredentialsProvider? = null
) {
    private val databaseScope = CoroutineScope(Dispatchers.IO)
    private var explicitAuthLens: AuthLens? = null

    private val _effectiveAuthLensFlow = MutableStateFlow(
        credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon
    )
    val authLensFlow: StateFlow<AuthLens> = _effectiveAuthLensFlow.asStateFlow()

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

    fun goOffline() {
        databaseScope.launch {
            try {
                bridgeClient.op(
                    method = "rtdb.goOffline",
                    params = emptyMap(),
                    actAs = getEffectiveAuthLens().toMap()
                )
            } catch (_: Exception) {}
        }
    }

    fun goOnline() {
        databaseScope.launch {
            try {
                bridgeClient.op(
                    method = "rtdb.goOnline",
                    params = emptyMap(),
                    actAs = getEffectiveAuthLens().toMap()
                )
            } catch (_: Exception) {}
        }
    }

    companion object {
        const val DEFAULT_DATABASE_URL = "https://pyric-sandbox-default-rtdb.firebaseio.com"
        private val instances = ConcurrentHashMap<Pair<String, String>, FirebaseDatabase>()

        @JvmStatic
        fun getInstance(): FirebaseDatabase =
            getInstance(FirebaseApp.getInstance(), DEFAULT_DATABASE_URL)

        @JvmStatic
        fun getInstance(url: String): FirebaseDatabase =
            getInstance(FirebaseApp.getInstance(), url)

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseDatabase =
            getInstance(app, DEFAULT_DATABASE_URL)

        @JvmStatic
        fun getInstance(app: FirebaseApp, url: String): FirebaseDatabase {
            return instances.computeIfAbsent(Pair(app.name, url)) {
                val bridge = PyricBridgeClient.createDefault()
                val auth = runCatching { FirebaseAuth.getInstance(app, bridge) }.getOrNull()
                FirebaseDatabase(bridge, app, url, credentialsProvider = auth)
            }
        }

        @JvmStatic
        fun getInstance(
            app: FirebaseApp,
            bridgeClient: PyricBridgeClient,
            url: String = DEFAULT_DATABASE_URL,
            credentialsProvider: CredentialsProvider? = null
        ): FirebaseDatabase {
            return instances.computeIfAbsent(Pair(app.name, url)) {
                val auth = credentialsProvider ?: runCatching { FirebaseAuth.getInstance(app, bridgeClient) }.getOrNull()
                FirebaseDatabase(bridgeClient, app, url, credentialsProvider = auth)
            }
        }

        @JvmStatic
        fun clearInstancesForTest() {
            instances.clear()
        }
    }
}

val Firebase.database: FirebaseDatabase
    get() = FirebaseDatabase.getInstance()

fun Firebase.database(url: String): FirebaseDatabase =
    FirebaseDatabase.getInstance(url)

fun Firebase.database(app: FirebaseApp): FirebaseDatabase =
    FirebaseDatabase.getInstance(app)

fun Firebase.database(app: FirebaseApp, url: String): FirebaseDatabase =
    FirebaseDatabase.getInstance(app, url)
