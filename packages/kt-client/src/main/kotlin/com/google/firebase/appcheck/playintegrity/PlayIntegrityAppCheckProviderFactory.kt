package com.google.firebase.appcheck.playintegrity

import com.google.firebase.FirebaseApp
import com.google.firebase.appcheck.AppCheckProvider
import com.google.firebase.appcheck.AppCheckProviderFactory
import dev.pyric.appcheck.BridgeAppCheckProvider

class PlayIntegrityAppCheckProviderFactory private constructor() : AppCheckProviderFactory {
    override fun create(firebaseApp: FirebaseApp): AppCheckProvider =
        BridgeAppCheckProvider(firebaseApp, PROVIDER_KIND)

    companion object {
        internal const val PROVIDER_KIND = "play-integrity"
        private val instance = PlayIntegrityAppCheckProviderFactory()

        @JvmStatic
        fun getInstance(): PlayIntegrityAppCheckProviderFactory = instance
    }
}
