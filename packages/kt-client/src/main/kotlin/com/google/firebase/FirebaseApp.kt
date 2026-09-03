package com.google.firebase

import java.util.concurrent.ConcurrentHashMap

class FirebaseApp private constructor(
    val name: String,
    val options: FirebaseOptions
) {
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

        fun getInstance(): FirebaseApp = getInstance(DEFAULT_APP_NAME)

        fun getInstance(name: String): FirebaseApp {
            return apps[name] ?: throw IllegalStateException(
                "Default FirebaseApp is not initialized in this process. Make sure to call FirebaseApp.initializeApp() first."
            )
        }

        fun initializeApp(options: FirebaseOptions): FirebaseApp =
            initializeApp(DEFAULT_APP_NAME, options)

        fun initializeApp(name: String, options: FirebaseOptions): FirebaseApp {
            val app = FirebaseApp(name, options)
            apps[name] = app
            return app
        }

        fun getApps(): List<FirebaseApp> = apps.values.toList()

        fun clearInstancesForTest() {
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
