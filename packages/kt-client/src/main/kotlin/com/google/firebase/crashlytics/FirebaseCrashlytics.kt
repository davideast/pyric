package com.google.firebase.crashlytics

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.io.PrintWriter
import java.io.StringWriter
import java.util.ArrayDeque
import java.util.IdentityHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

class FirebaseCrashlytics internal constructor(
    val app: FirebaseApp,
    private val explicitBridgeClient: PyricBridgeClient? = null,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val clockMillis: () -> Long = { System.currentTimeMillis() }
) {
    @OptIn(ExperimentalCoroutinesApi::class)
    private val serialDispatcher = dispatcher.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + serialDispatcher)
    private val stateLock = Any()

    private var collectionOverride: Boolean? = null
    private val sessionCustomKeys = LinkedHashMap<String, Any>()
    private val breadcrumbs = ArrayDeque<BreadcrumbEntry>()

    @Volatile
    private var previousExecutionCrashed: Boolean = false
    private val closed = AtomicBoolean(false)

    val bridgeClient: PyricBridgeClient
        get() = explicitBridgeClient ?: app.getOrCreateBridgeClient()

    internal val wireAppId: String?
        get() = if (app.name == FirebaseApp.DEFAULT_APP_NAME) null else app.name

    init {
        if (explicitBridgeClient != null) {
            app.getOrCreateBridgeClient(explicitBridgeClient)
        }
    }

    private data class BreadcrumbEntry(
        val message: String,
        val timestampMs: Long
    ) {
        fun toWireMap(): Map<String, Any?> = mapOf(
            "message" to message,
            "timestampMs" to timestampMs
        )
    }

    fun isCrashlyticsCollectionEnabled(): Boolean = synchronized(stateLock) {
        collectionOverride ?: app.isDataCollectionDefaultEnabled
    }

    fun setCrashlyticsCollectionEnabled(enabled: Boolean) {
        applyCollectionEnabled(enabled)
    }

    fun setCrashlyticsCollectionEnabled(enabled: Boolean?) {
        applyCollectionEnabled(enabled)
    }

    private fun applyCollectionEnabled(enabled: Boolean?) {
        val resolved = synchronized(stateLock) {
            collectionOverride = enabled
            enabled ?: app.isDataCollectionDefaultEnabled
        }
        scope.launch {
            val params = baseParams()
            // Send explicit boolean or null override matching shared contract { appId?, enabled: boolean | null }
            params["enabled"] = enabled ?: resolved
            if (enabled == null) {
                params["enabled"] = null
            }
            runCatching {
                bridgeClient.op("crashlytics.setCollectionEnabled", params)
            }
        }
    }

    fun log(message: String) {
        val ts = clockMillis()
        synchronized(stateLock) {
            if (breadcrumbs.size >= MAX_BREADCRUMBS) {
                breadcrumbs.removeFirst()
            }
            breadcrumbs.addLast(BreadcrumbEntry(message = message, timestampMs = ts))
        }
        scope.launch {
            val params = baseParams()
            params["message"] = message
            params["timestampMs"] = ts
            runCatching {
                bridgeClient.op("crashlytics.log", params)
            }
        }
    }

    fun setUserId(identifier: String) {
        scope.launch {
            val params = baseParams()
            params["userId"] = identifier
            runCatching {
                bridgeClient.op("crashlytics.setUserId", params)
            }
        }
    }

    fun setCustomKey(key: String, value: Boolean) {
        putSingleCustomKey(key, value)
    }

    fun setCustomKey(key: String, value: Double) {
        putSingleCustomKey(key, CustomKeysAndValues.Builder.normalizeFiniteDouble(value))
    }

    fun setCustomKey(key: String, value: Float) {
        val normalized: Any = if (value.isFinite()) value.toString().toDouble() else value.toString()
        putSingleCustomKey(key, normalized)
    }

    fun setCustomKey(key: String, value: Int) {
        putSingleCustomKey(key, value)
    }

    fun setCustomKey(key: String, value: Long) {
        putSingleCustomKey(key, value)
    }

    fun setCustomKey(key: String, value: String) {
        putSingleCustomKey(key, value)
    }

    private fun putSingleCustomKey(key: String, value: Any) {
        synchronized(stateLock) {
            sessionCustomKeys[key] = value
        }
        dispatchCustomKeys(mapOf(key to value))
    }

    fun setCustomKeys(keysAndValues: CustomKeysAndValues) {
        if (keysAndValues.keysAndValues.isEmpty()) {
            return
        }
        val snapshot = LinkedHashMap(keysAndValues.keysAndValues)
        synchronized(stateLock) {
            sessionCustomKeys.putAll(snapshot)
        }
        dispatchCustomKeys(snapshot)
    }

    private fun dispatchCustomKeys(keys: Map<String, Any>) {
        scope.launch {
            val params = baseParams()
            params["keys"] = LinkedHashMap<String, Any?>(keys)
            runCatching {
                bridgeClient.op("crashlytics.setCustomKeys", params)
            }
        }
    }

    fun recordException(throwable: Throwable) {
        enqueueExceptionReport(throwable, extraKeys = emptyMap())
    }

    fun recordException(throwable: Throwable, keysAndValues: CustomKeysAndValues) {
        enqueueExceptionReport(throwable, extraKeys = keysAndValues.keysAndValues)
    }

    private fun enqueueExceptionReport(throwable: Throwable, extraKeys: Map<String, Any>) {
        val ts = clockMillis()
        val (enabledNow, mergedAttributes, breadcrumbSnapshot) = synchronized(stateLock) {
            val enabled = collectionOverride ?: app.isDataCollectionDefaultEnabled
            val attrs = LinkedHashMap<String, Any?>()
            attrs.putAll(sessionCustomKeys)
            attrs.putAll(extraKeys)
            val crumbs = breadcrumbs.map { it.toWireMap() }
            Triple(enabled, attrs, crumbs)
        }

        val errorName = throwable.javaClass.name
        val errorMessage = throwable.message ?: errorName
        val stackString = formatStackTrace(throwable)
        val causeSummary = formatCauseChain(throwable.cause)

        scope.launch {
            val params = baseParams()
            params["name"] = errorName
            params["message"] = errorMessage
            params["stack"] = stackString
            if (causeSummary != null) {
                params["cause"] = causeSummary
            }
            params["fatal"] = false
            if (mergedAttributes.isNotEmpty()) {
                params["attributes"] = mergedAttributes
            }
            if (breadcrumbSnapshot.isNotEmpty()) {
                params["breadcrumbs"] = breadcrumbSnapshot
            }
            params["timestampMs"] = ts
            params["sdkPlatform"] = SDK_PLATFORM_ANDROID
            params["deferred"] = !enabledNow
            runCatching {
                bridgeClient.op("crashlytics.recordError", params)
            }
        }
    }

    fun checkForUnsentReports(): Task<Boolean> {
        if (closed.get()) {
            return Tasks.forException(IllegalStateException(CLOSED_MESSAGE))
        }
        val tcs = TaskCompletionSource<Boolean>()
        scope.launch {
            try {
                val raw = bridgeClient.op("crashlytics.checkForUnsentReports", baseParams()) as? Map<*, *>
                val hasUnsent = (raw?.get("hasUnsentReports") as? Boolean)
                    ?: (((raw?.get("count") as? Number)?.toInt() ?: 0) > 0)
                tcs.setResult(hasUnsent)
            } catch (e: CancellationException) {
                tcs.setException(IllegalStateException(CLOSED_MESSAGE, e))
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun sendUnsentReports() {
        scope.launch {
            runCatching {
                bridgeClient.op("crashlytics.sendUnsentReports", baseParams())
            }
        }
    }

    fun deleteUnsentReports() {
        scope.launch {
            runCatching {
                bridgeClient.op("crashlytics.deleteUnsentReports", baseParams())
            }
        }
    }

    fun didCrashOnPreviousExecution(): Boolean = previousExecutionCrashed

    fun simulatePreviousCrashForTest(didCrash: Boolean = true) {
        previousExecutionCrashed = didCrash
    }

    fun flush(): Task<Void?> {
        if (closed.get()) {
            return Tasks.forException(IllegalStateException(CLOSED_MESSAGE))
        }
        val tcs = TaskCompletionSource<Void?>()
        scope.launch {
            try {
                bridgeClient.op("crashlytics.flush", baseParams())
                tcs.setResult(null)
            } catch (e: CancellationException) {
                tcs.setException(IllegalStateException(CLOSED_MESSAGE, e))
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun getState(): Task<Map<String, Any?>> {
        if (closed.get()) {
            return Tasks.forException(IllegalStateException(CLOSED_MESSAGE))
        }
        val tcs = TaskCompletionSource<Map<String, Any?>>()
        scope.launch {
            try {
                @Suppress("UNCHECKED_CAST")
                val raw = (bridgeClient.op("crashlytics.getState", baseParams()) as? Map<String, Any?>)
                    ?: emptyMap()
                val remoteDidCrash = raw["didCrashOnPreviousExecution"] as? Boolean
                if (remoteDidCrash != null) {
                    previousExecutionCrashed = remoteDidCrash
                }
                tcs.setResult(raw)
            } catch (e: CancellationException) {
                tcs.setException(IllegalStateException(CLOSED_MESSAGE, e))
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    private fun baseParams(): LinkedHashMap<String, Any?> {
        val map = LinkedHashMap<String, Any?>()
        val id = wireAppId
        if (id != null) {
            map["appId"] = id
        }
        return map
    }

    fun close() {
        closed.set(true)
        scope.cancel()
    }

    companion object {
        private const val CLOSED_MESSAGE: String = "FirebaseCrashlytics instance has been closed."
        internal const val SDK_PLATFORM_ANDROID: String = "android"
        internal const val MAX_BREADCRUMBS: Int = 64
        private const val MAX_CAUSE_DEPTH: Int = 16

        private val instances = ConcurrentHashMap<String, FirebaseCrashlytics>()

        @JvmStatic
        @Synchronized
        fun getInstance(): FirebaseCrashlytics = getInstance(FirebaseApp.getInstance())

        @JvmStatic
        @Synchronized
        fun getInstance(app: FirebaseApp): FirebaseCrashlytics {
            val existing = instances[app.name]
            if (existing != null && existing.app === app) {
                return existing
            }
            existing?.close()
            val created = FirebaseCrashlytics(app = app)
            instances[app.name] = created
            return created
        }

        @JvmStatic
        @Synchronized
        internal fun getInstance(
            app: FirebaseApp,
            bridgeClient: PyricBridgeClient
        ): FirebaseCrashlytics {
            val existing = instances[app.name]
            if (existing != null && existing.app === app && existing.bridgeClient === bridgeClient) {
                return existing
            }
            existing?.close()
            val created = FirebaseCrashlytics(app = app, explicitBridgeClient = bridgeClient)
            instances[app.name] = created
            return created
        }

        @JvmStatic
        @Synchronized
        fun clearInstancesForTest() {
            for (instance in instances.values) {
                instance.close()
            }
            instances.clear()
        }

        internal fun formatStackTrace(throwable: Throwable): String {
            val sw = StringWriter()
            PrintWriter(sw).use { pw ->
                throwable.printStackTrace(pw)
            }
            return sw.toString().trimEnd()
        }

        internal fun formatCauseChain(rootCause: Throwable?): String? {
            if (rootCause == null) {
                return null
            }
            val seen = IdentityHashMap<Throwable, Boolean>()
            val parts = ArrayList<String>()
            var current: Throwable? = rootCause
            var depth = 0
            while (current != null && depth < MAX_CAUSE_DEPTH) {
                if (seen.put(current, true) != null) {
                    parts.add("[CIRCULAR REFERENCE: ${current.javaClass.name}]")
                    break
                }
                val msg = current.message
                if (msg.isNullOrEmpty()) {
                    parts.add(current.javaClass.name)
                } else {
                    parts.add("${current.javaClass.name}: $msg")
                }
                current = current.cause
                depth += 1
            }
            return parts.joinToString(" <- ")
        }
    }
}
