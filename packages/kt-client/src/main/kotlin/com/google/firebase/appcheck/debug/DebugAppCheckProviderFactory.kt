package com.google.firebase.appcheck.debug

import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckProviderFactory
import dev.pyric.appcheck.BridgeAppCheckProvider

class DebugAppCheckProviderFactory private constructor() : AppCheckProviderFactory {
    override fun create(firebaseApp: FirebaseApp): AppCheckProvider =
        BridgeAppCheckProvider(firebaseApp, PROVIDER_KIND)

    companion object {
        internal const val PROVIDER_KIND = "debug"
        private val instance = DebugAppCheckProviderFactory()

        @JvmStatic
        fun getInstance(): DebugAppCheckProviderFactory = instance
    }
}
