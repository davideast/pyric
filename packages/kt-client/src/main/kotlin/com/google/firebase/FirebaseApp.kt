package com.google.firebase

import com.google.firebase.appcheck.FirebaseAppCheck
import dev.pyric.bridge.PyricBridgeClient
import java.util.concurrent.ConcurrentHashMap

class FirebaseApp private constructor(
    val name: String,
    val options: FirebaseOptions
) {
    private val bridgeLock = Any()

    @Volatile
    private var sharedBridgeClient: PyricBridgeClient? = null

    @Volatile
    var isDataCollectionDefaultEnabled: Boolean = true

    @Volatile
    internal var appCheckTokenProvider: (suspend () -> String?)? = null

    internal fun bindBridgeClient(client: PyricBridgeClient): PyricBridgeClient {
        client.appCheckTokenProvider = { appCheckTokenProvider?.invoke() }
        return client
    }

    internal fun getOrCreateBridgeClient(explicit: PyricBridgeClient? = null): PyricBridgeClient {
        synchronized(bridgeLock) {
            if (explicit != null) {
                val current = sharedBridgeClient
                if (current == null || current.isDisposed) {
                    sharedBridgeClient = explicit
                }
                return bindBridgeClient(explicit)
            }
            val existing = sharedBridgeClient
            if (existing != null && !existing.isDisposed) {
                return bindBridgeClient(existing)
            }
            val created = PyricBridgeClient.createDefault()
            sharedBridgeClient = created
            return bindBridgeClient(created)
        }
    }

    internal fun terminateSharedBridgeClient() {
        appCheckTokenProvider = null
        val existing = synchronized(bridgeLock) {
            val client = sharedBridgeClient
            sharedBridgeClient = null
            client
        }
        existing?.terminate()
    }

    companion object {
        const val DEFAULT_APP_NAME = "[DEFAULT]"
        private val apps = ConcurrentHashMap<String, FirebaseApp>()

        private fun defaultSandboxOptions(): FirebaseOptions =
            FirebaseOptions.Builder()
                .setProjectId("pyric-sandbox")
                .setApiKey("sandbox-api-key")
                .setApplicationId("dev.pyric.app")
                .build()

        init {
            // Provide an out-of-the-box default app if not explicitly initialized
            apps[DEFAULT_APP_NAME] = FirebaseApp(DEFAULT_APP_NAME, defaultSandboxOptions())
        }

        @JvmStatic
        fun getInstance(): FirebaseApp = getInstance(DEFAULT_APP_NAME)

        @JvmStatic
        fun getInstance(name: String): FirebaseApp {
            return apps[name] ?: throw IllegalStateException(
                "Default FirebaseApp is not initialized in this process. Make sure to call FirebaseApp.initializeApp() first."
            )
        }

        @JvmStatic
        @Suppress("UNUSED_PARAMETER")
        fun initializeApp(context: Any): FirebaseApp {
            val existing = apps[DEFAULT_APP_NAME]
            if (existing != null) {
                return existing
            }
            return initializeApp(DEFAULT_APP_NAME, defaultSandboxOptions())
        }

        @JvmStatic
        fun initializeApp(options: FirebaseOptions): FirebaseApp =
            initializeApp(DEFAULT_APP_NAME, options)

        @JvmStatic
        @Suppress("UNUSED_PARAMETER")
        fun initializeApp(context: Any, options: FirebaseOptions): FirebaseApp =
            initializeApp(DEFAULT_APP_NAME, options)

        @JvmStatic
        @Suppress("UNUSED_PARAMETER")
        fun initializeApp(context: Any, options: FirebaseOptions, name: String): FirebaseApp =
            initializeApp(name, options)

        @JvmStatic
        fun initializeApp(name: String, options: FirebaseOptions): FirebaseApp {
            FirebaseAppCheck.onAppCleared(name)
            val previous = apps.remove(name)
            previous?.terminateSharedBridgeClient()
            val app = FirebaseApp(name, options)
            apps[name] = app
            return app
        }

        @JvmStatic
        fun getApps(): List<FirebaseApp> = apps.values.toList()

        @JvmStatic
        @Suppress("UNUSED_PARAMETER")
        fun getApps(context: Any): List<FirebaseApp> = getApps()

        @JvmStatic
        fun clearInstancesForTest() {
            FirebaseAppCheck.clearInstancesForTest()
            for (app in apps.values) {
                app.terminateSharedBridgeClient()
            }
            apps.clear()
            apps[DEFAULT_APP_NAME] = FirebaseApp(DEFAULT_APP_NAME, defaultSandboxOptions())
        }
    }
}

object Firebase

val Firebase.app: FirebaseApp
    get() = FirebaseApp.getInstance()

fun Firebase.app(name: String): FirebaseApp = FirebaseApp.getInstance(name)

fun Firebase.initialize(context: Any): FirebaseApp? = FirebaseApp.initializeApp(context)

fun Firebase.initialize(context: Any, options: FirebaseOptions): FirebaseApp =
    FirebaseApp.initializeApp(context, options)

fun Firebase.initialize(context: Any, options: FirebaseOptions, name: String): FirebaseApp =
    FirebaseApp.initializeApp(context, options, name)
