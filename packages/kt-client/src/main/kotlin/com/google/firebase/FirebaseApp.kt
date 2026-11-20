package com.google.firebase

import dev.pyric.bridge.PyricBridgeClient
import java.util.concurrent.ConcurrentHashMap

class FirebaseApp private constructor(
    val name: String,
    val options: FirebaseOptions
) {
    private val bridgeLock = Any()

    @Volatile
    private var sharedBridgeClient: PyricBridgeClient? = null

    internal fun getOrCreateBridgeClient(explicit: PyricBridgeClient? = null): PyricBridgeClient {
        synchronized(bridgeLock) {
            if (explicit != null) {
                val current = sharedBridgeClient
                if (current == null || current.isDisposed) {
                    sharedBridgeClient = explicit
                }
                return explicit
            }
            val existing = sharedBridgeClient
            if (existing != null && !existing.isDisposed) {
                return existing
            }
            val created = PyricBridgeClient.createDefault()
            sharedBridgeClient = created
            return created
        }
    }

    internal fun terminateSharedBridgeClient() {
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

        init {
            // Provide an out-of-the-box default app if not explicitly initialized
            val defaultOptions = FirebaseOptions.Builder()
                .setProjectId("pyric-sandbox")
                .setApiKey("sandbox-api-key")
                .setApplicationId("dev.pyric.app")
                .build()
            apps[DEFAULT_APP_NAME] = FirebaseApp(DEFAULT_APP_NAME, defaultOptions)
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
        fun initializeApp(options: FirebaseOptions): FirebaseApp =
            initializeApp(DEFAULT_APP_NAME, options)

        @JvmStatic
        fun initializeApp(name: String, options: FirebaseOptions): FirebaseApp {
            val previous = apps.remove(name)
            previous?.terminateSharedBridgeClient()
            val app = FirebaseApp(name, options)
            apps[name] = app
            return app
        }

        @JvmStatic
        fun getApps(): List<FirebaseApp> = apps.values.toList()

        @JvmStatic
        fun clearInstancesForTest() {
            for (app in apps.values) {
                app.terminateSharedBridgeClient()
            }
            apps.clear()
            val defaultOptions = FirebaseOptions.Builder()
                .setProjectId("pyric-sandbox")
                .setApiKey("sandbox-api-key")
                .setApplicationId("dev.pyric.app")
                .build()
            apps[DEFAULT_APP_NAME] = FirebaseApp(DEFAULT_APP_NAME, defaultOptions)
        }
    }
}

object Firebase
