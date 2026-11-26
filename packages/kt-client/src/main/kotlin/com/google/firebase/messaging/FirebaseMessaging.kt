package com.google.firebase.messaging

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import dev.pyric.bridge.BridgeSubscriptionHandle
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

class FirebaseMessaging internal constructor(
    val app: FirebaseApp,
    private val explicitBridgeClient: PyricBridgeClient? = null,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO
) {
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val stateLock = Any()

    private var cachedToken: String? = null
    private var lastAnnouncedToken: String? = null
    private var inFlightToken: CompletableDeferred<String>? = null
    private var serviceForegroundHandle: BridgeSubscriptionHandle? = null
    private var serviceBackgroundHandle: BridgeSubscriptionHandle? = null

    @Volatile
    private var autoInitEnabledFlag: Boolean = app.isDataCollectionDefaultEnabled

    @Volatile
    private var deliveryMetricsExportFlag: Boolean = false

    @Volatile
    private var notificationDelegationFlag: Boolean = false

    private val registeredServices = CopyOnWriteArrayList<FirebaseMessagingService>()
    private val _newTokenFlow = MutableSharedFlow<String>(extraBufferCapacity = 1 shl 20)
    val newTokenFlow: SharedFlow<String> = _newTokenFlow.asSharedFlow()

    val bridgeClient: PyricBridgeClient
        get() = explicitBridgeClient ?: app.getOrCreateBridgeClient()

    internal val registrationId: String
        get() = if (app.name == FirebaseApp.DEFAULT_APP_NAME) {
            DEFAULT_REGISTRATION_ID
        } else {
            "swreg-kt-${app.name}"
        }

    init {
        if (explicitBridgeClient != null) {
            app.getOrCreateBridgeClient(explicitBridgeClient)
        }
    }

    var isAutoInitEnabled: Boolean
        get() = autoInitEnabledFlag
        set(value) {
            val becameEnabled = synchronized(stateLock) {
                val wasEnabled = autoInitEnabledFlag
                autoInitEnabledFlag = value
                !wasEnabled && value
            }
            if (becameEnabled) {
                scope.launch {
                    runCatching { fetchOrMintToken() }
                }
            }
        }

    fun deliveryMetricsExportToBigQueryEnabled(): Boolean = deliveryMetricsExportFlag

    fun setDeliveryMetricsExportToBigQuery(enable: Boolean) {
        deliveryMetricsExportFlag = enable
    }

    val isNotificationDelegationEnabled: Boolean
        get() = notificationDelegationFlag

    fun setNotificationDelegationEnabled(enable: Boolean): Task<Void?> {
        notificationDelegationFlag = enable
        return Tasks.forResult(null)
    }

    val token: Task<String>
        get() {
            val tcs = TaskCompletionSource<String>()
            scope.launch {
                try {
                    tcs.setResult(fetchOrMintToken())
                } catch (e: Exception) {
                    tcs.setException(e)
                }
            }
            return tcs.task
        }

    fun register(): Task<Void?> {
        return token.continueWith { completed ->
            if (!completed.isSuccessful) {
                throw (completed.exception ?: IOException("FCM registration failed"))
            }
            null
        }
    }

    fun deleteToken(): Task<Void?> {
        val tcs = TaskCompletionSource<Void?>()
        scope.launch {
            try {
                bridgeClient.op(
                    method = "messaging.deleteToken",
                    params = mapOf("registrationId" to registrationId)
                )
                val previous = synchronized(stateLock) {
                    val prev = cachedToken ?: lastAnnouncedToken
                    cachedToken = null
                    lastAnnouncedToken = null
                    inFlightToken?.cancel()
                    inFlightToken = null
                    prev
                }
                if (previous != null) {
                    for (service in registeredServices) {
                        runCatching { service.onUnregistered(previous) }
                    }
                }
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun unregister(): Task<Void?> = deleteToken()

    fun subscribeToTopic(topic: String): Task<Void?> = mutateTopicSubscription(topic, subscribe = true)

    fun unsubscribeFromTopic(topic: String): Task<Void?> = mutateTopicSubscription(topic, subscribe = false)

    private fun mutateTopicSubscription(topic: String, subscribe: Boolean): Task<Void?> {
        val normalized = try {
            TopicOperation.normalizeTopicOrThrow(topic)
        } catch (e: IllegalArgumentException) {
            return Tasks.forException(e)
        }

        val tcs = TaskCompletionSource<Void?>()
        scope.launch {
            try {
                val activeToken = fetchOrMintToken()
                val method = if (subscribe) {
                    "messaging.subscribeToTopic"
                } else {
                    "messaging.unsubscribeFromTopic"
                }
                val rawOutcome = bridgeClient.op(
                    method = method,
                    params = mapOf(
                        "tokens" to listOf(activeToken),
                        "topic" to normalized
                    )
                ) as? Map<*, *>

                val failures = (rawOutcome?.get("failureCount") as? Number)?.toInt() ?: 0
                if (failures > 0) {
                    val errorsList = rawOutcome?.get("errors") as? List<*>
                    val firstError = errorsList?.firstOrNull() as? Map<*, *>
                    val reason = firstError?.get("reason")?.toString() ?: "TOPIC_SUBSCRIPTION_FAILED"
                    throw IOException("Topic operation '$method' failed for '$normalized': $reason")
                }
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    fun send(message: RemoteMessage) {
        if (message.to.isNullOrEmpty()) {
            throw IllegalArgumentException("Missing 'to'")
        }
        val fallbackMsgId = message.messageId?.takeIf { it.isNotEmpty() } ?: UUID.randomUUID().toString()
        val wireMessage = message.toBrokerMessage()
        scope.launch {
            try {
                val rawAccepted = bridgeClient.op(
                    method = "messaging.send",
                    params = mapOf("message" to wireMessage)
                ) as? Map<*, *>
                val acceptedId = message.messageId?.takeIf { it.isNotEmpty() }
                    ?: (rawAccepted?.get("messageId") as? String)
                    ?: fallbackMsgId
                for (service in registeredServices) {
                    runCatching { service.onMessageSent(acceptedId) }
                }
            } catch (t: Throwable) {
                val sendException = SendException.fromBridgeFailure(t)
                for (service in registeredServices) {
                    runCatching { service.onSendError(fallbackMsgId, sendException) }
                }
            }
        }
    }

    fun setVisibility(visible: Boolean): Task<Void?> =
        setVisibility(if (visible) "visible" else "hidden")

    fun setVisibility(state: String): Task<Void?> {
        val normalized = state.trim().lowercase()
        if (normalized != "visible" && normalized != "hidden") {
            return Tasks.forException(
                IllegalArgumentException("Visibility state must be 'visible' or 'hidden', got: $state")
            )
        }
        val tcs = TaskCompletionSource<Void?>()
        scope.launch {
            try {
                bridgeClient.op(
                    method = "messaging.setVisibility",
                    params = mapOf("state" to normalized)
                )
                tcs.setResult(null)
            } catch (e: Exception) {
                tcs.setException(e)
            }
        }
        return tcs.task
    }

    val foregroundMessages: Flow<RemoteMessage>
        get() = bridgeClient.subscribe(TARGET_FOREGROUND).mapNotNull { raw ->
            (raw as? Map<*, *>)?.let { RemoteMessage.fromDeliveredPayload(it) }
        }

    val backgroundMessages: Flow<RemoteMessage>
        get() = bridgeClient.subscribe(TARGET_BACKGROUND).mapNotNull { raw ->
            (raw as? Map<*, *>)?.let { RemoteMessage.fromDeliveredPayload(it) }
        }

    fun registerService(service: FirebaseMessagingService) {
        if (!registeredServices.contains(service)) {
            registeredServices.add(service)
        }
        ensureServiceSubscriptionsRunning()
    }

    fun unregisterService(service: FirebaseMessagingService) {
        registeredServices.remove(service)
        if (registeredServices.isEmpty()) {
            stopServiceSubscriptions()
        }
    }

    private fun ensureServiceSubscriptionsRunning() {
        val openForeground: Boolean
        val openBackground: Boolean
        synchronized(stateLock) {
            openForeground = serviceForegroundHandle == null
            openBackground = serviceBackgroundHandle == null
        }
        val fgHandle = if (openForeground) openServiceSubscription(TARGET_FOREGROUND) else null
        val bgHandle = if (openBackground) openServiceSubscription(TARGET_BACKGROUND) else null
        var cancelFg: BridgeSubscriptionHandle? = null
        var cancelBg: BridgeSubscriptionHandle? = null
        synchronized(stateLock) {
            if (fgHandle != null) {
                if (serviceForegroundHandle == null && registeredServices.isNotEmpty()) {
                    serviceForegroundHandle = fgHandle
                } else {
                    cancelFg = fgHandle
                }
            }
            if (bgHandle != null) {
                if (serviceBackgroundHandle == null && registeredServices.isNotEmpty()) {
                    serviceBackgroundHandle = bgHandle
                } else {
                    cancelBg = bgHandle
                }
            }
        }
        cancelFg?.cancel()
        cancelBg?.cancel()
    }

    private fun openServiceSubscription(target: String): BridgeSubscriptionHandle? =
        runCatching {
            bridgeClient.openSubscription(
                target = target,
                onValue = { raw ->
                    val msg = (raw as? Map<*, *>)?.let { RemoteMessage.fromDeliveredPayload(it) } ?: return@openSubscription
                    for (svc in registeredServices) {
                        runCatching { svc.onMessageReceived(msg) }
                    }
                },
                onWireError = { clearServiceHandle(target) },
                onCloseError = { clearServiceHandle(target) }
            )
        }.getOrNull()

    private fun clearServiceHandle(target: String) {
        synchronized(stateLock) {
            if (target == TARGET_FOREGROUND) serviceForegroundHandle = null
            if (target == TARGET_BACKGROUND) serviceBackgroundHandle = null
        }
    }

    private fun stopServiceSubscriptions() {
        val fg: BridgeSubscriptionHandle?
        val bg: BridgeSubscriptionHandle?
        synchronized(stateLock) {
            fg = serviceForegroundHandle; serviceForegroundHandle = null
            bg = serviceBackgroundHandle; serviceBackgroundHandle = null
        }
        fg?.cancel()
        bg?.cancel()
    }

    private suspend fun fetchOrMintToken(): String {
        var cachedResult: String? = null
        var sharedDeferred: CompletableDeferred<String>? = null
        var isInitiator = false

        synchronized(stateLock) {
            val cached = cachedToken
            if (cached != null) {
                cachedResult = cached
            } else {
                val currentInFlight = inFlightToken
                if (currentInFlight != null) {
                    sharedDeferred = currentInFlight
                } else {
                    val created = CompletableDeferred<String>()
                    inFlightToken = created
                    sharedDeferred = created
                    isInitiator = true
                }
            }
        }

        cachedResult?.let { return it }
        val deferred = sharedDeferred!!

        if (isInitiator) {
            try {
                val raw = bridgeClient.op(
                    method = "messaging.getToken",
                    params = mapOf("registrationId" to registrationId)
                ) as? Map<*, *>
                val minted = (raw?.get("token") as? String)?.takeIf { it.isNotEmpty() }
                    ?: throw IOException("Bridge messaging.getToken returned an empty token.")

                val shouldAnnounce = synchronized(stateLock) {
                    cachedToken = minted
                    if (inFlightToken === deferred) {
                        inFlightToken = null
                    }
                    val changed = lastAnnouncedToken != minted
                    lastAnnouncedToken = minted
                    changed
                }
                if (shouldAnnounce) {
                    _newTokenFlow.tryEmit(minted)
                    for (service in registeredServices) {
                        runCatching { service.onNewToken(minted) }
                        runCatching { service.onRegistered(minted) }
                    }
                }
                deferred.complete(minted)
            } catch (t: Throwable) {
                synchronized(stateLock) {
                    if (inFlightToken === deferred) {
                        inFlightToken = null
                    }
                }
                deferred.completeExceptionally(t)
            }
        }
        return deferred.await()
    }

    fun close() {
        stopServiceSubscriptions()
        registeredServices.clear()
        scope.cancel()
    }

    companion object {
        const val INSTANCE_ID_SCOPE: String = "FCM"
        internal const val DEFAULT_REGISTRATION_ID: String = "swreg-port-default"
        internal const val TARGET_FOREGROUND: String = "messaging.foreground"
        internal const val TARGET_BACKGROUND: String = "messaging.background"

        private val instances = ConcurrentHashMap<String, FirebaseMessaging>()

        @JvmStatic
        @Synchronized
        fun getInstance(): FirebaseMessaging = getInstance(FirebaseApp.getInstance())

        @JvmStatic
        @Synchronized
        fun getInstance(app: FirebaseApp): FirebaseMessaging {
            val existing = instances[app.name]
            if (existing != null && existing.app === app) {
                return existing
            }
            existing?.close()
            val created = FirebaseMessaging(app = app)
            instances[app.name] = created
            return created
        }

        @JvmStatic
        internal fun getInstance(app: FirebaseApp, bridgeClient: PyricBridgeClient): FirebaseMessaging {
            val existing = instances[app.name]
            if (existing != null && existing.app === app && existing.bridgeClient === bridgeClient) {
                return existing
            }
            existing?.close()
            val created = FirebaseMessaging(app = app, explicitBridgeClient = bridgeClient)
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
    }
}
