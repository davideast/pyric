package com.google.firebase.appcheck

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.tasks.await
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseException
import dev.pyric.appcheck.BridgeAppCheckProvider
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

open class FirebaseAppCheck internal constructor(
    val app: FirebaseApp,
    private val explicitBridgeClient: PyricBridgeClient? = null,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val clockMillis: () -> Long = { System.currentTimeMillis() }
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val stateLock = Any()

    private var installedProviderFactory: AppCheckProviderFactory? = null
    private var installedProvider: AppCheckProvider? = null
    private var cachedToken: AppCheckToken? = null
    private var inFlightMint: CompletableDeferred<AppCheckToken>? = null
    private var mintGeneration: Long = 0L
    private var autoRefreshJob: Job? = null

    @Volatile
    private var tokenAutoRefreshRequested: Boolean = app.isDataCollectionDefaultEnabled

    val isTokenAutoRefreshEnabled: Boolean
        get() = tokenAutoRefreshRequested && app.isDataCollectionDefaultEnabled

    val bridgeClient: PyricBridgeClient
        get() = explicitBridgeClient ?: app.getOrCreateBridgeClient()

    private class AppCheckListenerEntry(val listener: AppCheckListener) {
        val active = AtomicBoolean(true)
    }

    private val appCheckListeners = CopyOnWriteArrayList<AppCheckListenerEntry>()

    init {
        if (explicitBridgeClient != null) {
            app.getOrCreateBridgeClient(explicitBridgeClient)
        }
        app.appCheckTokenProvider = { getTokenForSharedRequest() }
    }

    fun interface AppCheckListener {
        fun onAppCheckTokenChanged(token: AppCheckToken)
    }

    open fun installAppCheckProviderFactory(factory: AppCheckProviderFactory) {
        installAppCheckProviderFactory(factory, app.isDataCollectionDefaultEnabled)
    }

    open fun installAppCheckProviderFactory(
        factory: AppCheckProviderFactory,
        isTokenAutoRefreshEnabled: Boolean
    ) {
        val createdProvider = factory.create(app)
        synchronized(stateLock) {
            mintGeneration += 1L
            installedProviderFactory = factory
            installedProvider = createdProvider
            tokenAutoRefreshRequested = isTokenAutoRefreshEnabled
            cachedToken = null
            inFlightMint?.cancel()
            inFlightMint = null
            autoRefreshJob?.cancel()
            autoRefreshJob = null
        }
        app.appCheckTokenProvider = { getTokenForSharedRequest() }
    }

    open fun setTokenAutoRefreshEnabled(isTokenAutoRefreshEnabled: Boolean) {
        synchronized(stateLock) {
            tokenAutoRefreshRequested = isTokenAutoRefreshEnabled
            scheduleAutoRefreshLocked()
        }
    }

    open fun addAppCheckListener(listener: AppCheckListener) {
        val entry = synchronized(stateLock) {
            appCheckListeners.firstOrNull { it.listener == listener && it.active.get() }
                ?: AppCheckListenerEntry(listener).also { appCheckListeners.add(it) }
        }
        val currentValid = synchronized(stateLock) {
            scheduleAutoRefreshLocked()
            val current = cachedToken
            if (current != null && isValidToken(current)) current else null
        }
        if (currentValid != null) {
            synchronized(entry) {
                if (!entry.active.get()) return@synchronized
                try {
                    entry.listener.onAppCheckTokenChanged(currentValid)
                } catch (_: Throwable) {}
            }
        }
    }

    open fun removeAppCheckListener(listener: AppCheckListener) {
        val entry = appCheckListeners.firstOrNull {
            it.listener == listener && it.active.compareAndSet(true, false)
        }
        if (entry != null) {
            appCheckListeners.remove(entry)
            synchronized(entry) {}
        }
        synchronized(stateLock) {
            scheduleAutoRefreshLocked()
        }
    }

    open fun getAppCheckToken(forceRefresh: Boolean): Task<AppCheckToken> {
        val hasProvider = synchronized(stateLock) { installedProvider != null }
        if (!hasProvider) {
            return Tasks.forException(FirebaseException(NO_PROVIDER_INSTALLED_MESSAGE))
        }
        if (!forceRefresh) {
            val validCached = synchronized(stateLock) {
                val current = cachedToken
                if (current != null && isValidToken(current)) current else null
            }
            if (validCached != null) {
                return Tasks.forResult(validCached)
            }
        }

        val tcs = TaskCompletionSource<AppCheckToken>()
        scope.launch {
            try {
                val resolved = getOrMintToken(forceRefresh)
                tcs.setResult(resolved)
            } catch (e: Throwable) {
                tcs.setException(BridgeAppCheckProvider.toFirebaseException(e))
            }
        }
        return tcs.task
    }

    open fun getLimitedUseAppCheckToken(): Task<AppCheckToken> {
        val provider = synchronized(stateLock) { installedProvider }
            ?: return Tasks.forException(FirebaseException(NO_PROVIDER_INSTALLED_MESSAGE))

        val tcs = TaskCompletionSource<AppCheckToken>()
        scope.launch {
            try {
                val minted = if (provider is BridgeAppCheckProvider) {
                    provider.fetchLimitedUseToken()
                } else {
                    provider.getToken().await()
                }
                tcs.setResult(minted)
            } catch (e: Throwable) {
                tcs.setException(BridgeAppCheckProvider.toFirebaseException(e))
            }
        }
        return tcs.task
    }

    internal suspend fun getTokenForSharedRequest(): String? {
        val hasProvider = synchronized(stateLock) { installedProvider != null }
        if (!hasProvider) {
            return null
        }
        return try {
            getOrMintToken(forceRefresh = false).token
        } catch (_: Throwable) {
            APP_CHECK_PLACEHOLDER_TOKEN
        }
    }

    private suspend fun getOrMintToken(forceRefresh: Boolean): AppCheckToken {
        var ownsMint = false
        var capturedGeneration = 0L
        val deferredToAwait: CompletableDeferred<AppCheckToken>
        val providerToCall: AppCheckProvider

        synchronized(stateLock) {
            val provider = installedProvider
                ?: throw FirebaseException(NO_PROVIDER_INSTALLED_MESSAGE)
            if (!forceRefresh) {
                val current = cachedToken
                if (current != null && isValidToken(current)) {
                    return current
                }
                val existingInFlight = inFlightMint
                if (existingInFlight != null) {
                    deferredToAwait = existingInFlight
                    providerToCall = provider
                } else {
                    val created = CompletableDeferred<AppCheckToken>()
                    inFlightMint = created
                    mintGeneration += 1L
                    capturedGeneration = mintGeneration
                    ownsMint = true
                    deferredToAwait = created
                    providerToCall = provider
                }
            } else {
                mintGeneration += 1L
                capturedGeneration = mintGeneration
                ownsMint = true
                deferredToAwait = CompletableDeferred()
                providerToCall = provider
            }
        }

        if (!ownsMint) {
            return deferredToAwait.await()
        }

        try {
            val minted = providerToCall.getToken().await()
            val shouldNotify = synchronized(stateLock) {
                if (inFlightMint === deferredToAwait) {
                    inFlightMint = null
                }
                val stillActive = installedProvider === providerToCall &&
                    mintGeneration == capturedGeneration
                if (stillActive) {
                    val previousToken = cachedToken?.token
                    cachedToken = minted
                    scheduleAutoRefreshLocked()
                    previousToken != minted.token
                } else {
                    false
                }
            }
            deferredToAwait.complete(minted)
            if (shouldNotify) {
                notifyTokenChanged(minted)
            }
            return minted
        } catch (e: Throwable) {
            val wrapped = BridgeAppCheckProvider.toFirebaseException(e)
            synchronized(stateLock) {
                if (inFlightMint === deferredToAwait) {
                    inFlightMint = null
                }
            }
            deferredToAwait.completeExceptionally(wrapped)
            throw wrapped
        }
    }

    private fun isValidToken(token: AppCheckToken): Boolean =
        token.expireTimeMillis > clockMillis()

    private fun notifyTokenChanged(token: AppCheckToken) {
        for (entry in appCheckListeners) {
            synchronized(entry) {
                if (!entry.active.get()) return@synchronized
                try {
                    entry.listener.onAppCheckTokenChanged(token)
                } catch (_: Throwable) {}
            }
        }
    }

    private fun scheduleAutoRefreshLocked() {
        autoRefreshJob?.cancel()
        autoRefreshJob = null
        if (!isTokenAutoRefreshEnabled) {
            return
        }
        val current = cachedToken ?: return
        val now = clockMillis()
        val remainingMs = current.expireTimeMillis - now
        if (remainingMs <= 0L) {
            return
        }
        val leadMs = (remainingMs / 2L).coerceAtMost(AUTO_REFRESH_BUFFER_MILLIS)
        val delayMs = (remainingMs - leadMs).coerceAtLeast(MIN_AUTO_REFRESH_DELAY_MILLIS)
        autoRefreshJob = scope.launch {
            delay(delayMs)
            val stillEnabled = synchronized(stateLock) {
                isTokenAutoRefreshEnabled && installedProvider != null
            }
            if (stillEnabled) {
                try {
                    getOrMintToken(forceRefresh = true)
                } catch (_: Throwable) {}
            }
        }
    }

    internal fun dispose() {
        synchronized(stateLock) {
            mintGeneration += 1L
            autoRefreshJob?.cancel()
            autoRefreshJob = null
            inFlightMint?.cancel()
            inFlightMint = null
            cachedToken = null
            installedProvider = null
            installedProviderFactory = null
        }
        appCheckListeners.forEach { it.active.set(false) }
        appCheckListeners.clear()
        scope.cancel()
    }

    companion object {
        internal const val NO_PROVIDER_INSTALLED_MESSAGE = "No AppCheckProvider installed."
        internal const val APP_CHECK_PLACEHOLDER_TOKEN = "eyJlcnJvciI6IlVOS05PV05fRVJST1IifQ=="
        private const val AUTO_REFRESH_BUFFER_MILLIS = 300_000L
        private const val MIN_AUTO_REFRESH_DELAY_MILLIS = 50L

        private val instances = ConcurrentHashMap<String, FirebaseAppCheck>()

        @JvmStatic
        fun getInstance(): FirebaseAppCheck = getInstance(FirebaseApp.getInstance())

        @JvmStatic
        fun getInstance(firebaseApp: FirebaseApp): FirebaseAppCheck {
            return instances.computeIfAbsent(firebaseApp.name) {
                FirebaseAppCheck(firebaseApp)
            }
        }

        @JvmStatic
        fun getInstance(
            firebaseApp: FirebaseApp,
            bridgeClient: PyricBridgeClient
        ): FirebaseAppCheck {
            return instances.computeIfAbsent(firebaseApp.name) {
                FirebaseAppCheck(firebaseApp, explicitBridgeClient = bridgeClient)
            }
        }

        internal fun getInstanceForTesting(
            firebaseApp: FirebaseApp,
            bridgeClient: PyricBridgeClient? = null,
            dispatcher: CoroutineDispatcher = Dispatchers.IO,
            clockMillis: () -> Long = { System.currentTimeMillis() }
        ): FirebaseAppCheck {
            val previous = instances.remove(firebaseApp.name)
            previous?.dispose()
            val created = FirebaseAppCheck(
                app = firebaseApp,
                explicitBridgeClient = bridgeClient,
                dispatcher = dispatcher,
                clockMillis = clockMillis
            )
            instances[firebaseApp.name] = created
            return created
        }

        internal fun resolveBridgeClient(app: FirebaseApp): PyricBridgeClient {
            val instance = instances[app.name]
            val explicit = instance?.explicitBridgeClient
            if (explicit != null && !explicit.isDisposed) {
                return explicit
            }
            return app.getOrCreateBridgeClient()
        }

        internal fun onAppCleared(appName: String) {
            val removed = instances.remove(appName)
            removed?.dispose()
        }

        @JvmStatic
        fun clearInstancesForTest() {
            for (appCheck in instances.values) {
                appCheck.dispose()
            }
            instances.clear()
        }
    }
}

val Firebase.appCheck: FirebaseAppCheck
    get() = FirebaseAppCheck.getInstance()

fun Firebase.appCheck(app: FirebaseApp): FirebaseAppCheck =
    FirebaseAppCheck.getInstance(app)

operator fun AppCheckToken.component1(): String = token

operator fun AppCheckToken.component2(): Long = expireTimeMillis
