package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import dev.pyric.auth.AuthLens
import dev.pyric.auth.CredentialsProvider
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

class FirebaseFirestore(
    val bridgeClient: PyricBridgeClient,
    val app: FirebaseApp,
    val databaseId: String,
    val credentialsProvider: CredentialsProvider? = null
) {
    constructor(
        bridgeClient: PyricBridgeClient,
        app: FirebaseApp,
        databaseId: String
    ) : this(bridgeClient, app, databaseId, credentialsProvider = null)

    fun interface RulesDenialListener {
        fun onDenial(exception: FirebaseFirestoreException, context: Map<String, Any?>)
    }

    private val firestoreJob = SupervisorJob()
    private val firestoreScope = CoroutineScope(firestoreJob + Dispatchers.IO)
    internal val listenerScope = CoroutineScope(SupervisorJob(firestoreJob) + Dispatchers.IO)
    internal val offlineCoordinator = FirestoreOfflineCoordinator(this, firestoreScope)
    private class DenialListenerEntry(val listener: RulesDenialListener) {
        val active = AtomicBoolean(true)
    }

    private val rulesDenialListeners = CopyOnWriteArrayList<DenialListenerEntry>()
    private val terminationLock = Any()
    private val terminationObservers = LinkedHashSet<() -> Unit>()
    private val _terminatedStateFlow = MutableStateFlow(false)
    internal val terminatedStateFlow: StateFlow<Boolean> = _terminatedStateFlow.asStateFlow()

    @Volatile
    internal var isStarted: Boolean = false
        private set

    @Volatile
    var isTerminated: Boolean = false
        private set

    private val unregisterDenialObserver: () -> Unit =
        bridgeClient.addDenialObserver(::notifyRulesDenial)

    var firestoreSettings: FirebaseFirestoreSettings = FirebaseFirestoreSettings.Builder().build()
        set(value) {
            checkNotTerminated()
            if (isStarted && field != value) {
                throw IllegalStateException(
                    "FirebaseFirestore has already been started and its settings can no longer be changed. " +
                        "You can only call setFirestoreSettings() before calling any other methods on a FirebaseFirestore object."
                )
            }
            field = value
        }

    internal fun checkNotTerminated() {
        check(!isTerminated) { "The client has already been terminated" }
    }

    internal fun ensureClientActive() {
        checkNotTerminated()
        isStarted = true
    }

    internal fun unvalidatedDocumentRef(cleanPath: String): DocumentReference =
        DocumentReference(this, cleanPath.trim('/'))

    fun addRulesDenialListener(listener: RulesDenialListener): ListenerRegistration {
        val entry = DenialListenerEntry(listener)
        rulesDenialListeners.add(entry)
        return ListenerRegistration {
            entry.active.set(false)
            rulesDenialListeners.remove(entry)
        }
    }

    fun removeRulesDenialListener(listener: RulesDenialListener) {
        val entry = rulesDenialListeners.firstOrNull {
            it.listener == listener && it.active.compareAndSet(true, false)
        }
        if (entry != null) {
            rulesDenialListeners.remove(entry)
        }
    }

    fun notifyRulesDenial(exception: FirebaseFirestoreException) {
        if (exception.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            @Suppress("UNCHECKED_CAST")
            val contextMap = (exception.denialContext as? Map<String, Any?>) ?: emptyMap()
            for (entry in rulesDenialListeners) {
                if (!entry.active.get()) continue
                try {
                    entry.listener.onDenial(exception, contextMap)
                } catch (_: Throwable) {}
            }
        }
    }

    fun getEffectiveAuthLens(): AuthLens =
        credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon

    val authLensFlow: StateFlow<AuthLens>
        get() = credentialsProvider?.authLensFlow ?: MutableStateFlow(AuthLens.Anon)

    fun collection(collectionPath: String): CollectionReference {
        checkNotTerminated()
        val segments = collectionPath.trim('/').split('/').filter { it.isNotEmpty() }
        require(segments.size % 2 == 1) {
            "Invalid collection reference. Collection references must have an odd number of segments, but $collectionPath has ${segments.size}"
        }
        return CollectionReference(this, collectionPath.trim('/'))
    }

    fun document(documentPath: String): DocumentReference {
        checkNotTerminated()
        val segments = documentPath.trim('/').split('/').filter { it.isNotEmpty() }
        require(segments.isNotEmpty() && segments.size % 2 == 0) {
            "Invalid document reference. Document references must have an even number of segments, but $documentPath has ${segments.size}"
        }
        return DocumentReference(this, documentPath.trim('/'))
    }

    fun collectionGroup(collectionId: String): Query {
        checkNotTerminated()
        require(!collectionId.contains('/')) {
            "Invalid collectionId '$collectionId'. Collection IDs must not contain '/'."
        }
        return Query(this, collectionId = collectionId, isCollectionGroup = true)
    }

    fun batch(): WriteBatch {
        checkNotTerminated()
        return WriteBatch(this)
    }

    fun runBatch(batchFunction: WriteBatch.Function): Task<Void?> {
        ensureClientActive()
        val batch = batch()
        batchFunction.apply(batch)
        return batch.commit()
    }

    fun <TResult> runTransaction(
        updateFunction: Transaction.Function<TResult>
    ): Task<TResult> = runTransaction(TransactionOptions.defaultOptions(), updateFunction)

    fun <TResult> runTransaction(
        options: TransactionOptions,
        updateFunction: Transaction.Function<TResult>
    ): Task<TResult> {
        ensureClientActive()
        val tcs = TaskCompletionSource<TResult>()
        val scope = CoroutineScope(Dispatchers.IO)

        scope.launch {
            var lastException: Exception? = null
            var exhaustedOnCommitContention = false
            for (attempt in 1..options.maxAttempts) {
                var inCommit = false
                try {
                    val txn = Transaction(this@FirebaseFirestore)
                    val result = updateFunction.apply(txn)
                    inCommit = true
                    bridgeClient.op(
                        method = "txnCommit",
                        params = mapOf(
                            "txnId" to txn.txnId,
                            "reads" to txn.reads,
                            "writes" to txn.writes
                        ),
                        actAs = getEffectiveAuthLens().toMap()
                    )
                    tcs.setResult(result)
                    return@launch
                } catch (e: Exception) {
                    lastException = e
                    if (!isRetryableTransactionError(e)) {
                        break
                    }
                    if (attempt == options.maxAttempts && inCommit) {
                        exhaustedOnCommitContention = true
                    }
                }
            }
            tcs.setException(
                mapExhaustedTransactionException(
                    lastException = lastException,
                    maxAttempts = options.maxAttempts,
                    exhaustedOnCommitContention = exhaustedOnCommitContention
                )
            )
        }

        return tcs.task
    }

    private fun mapExhaustedTransactionException(
        lastException: Exception?,
        maxAttempts: Int,
        exhaustedOnCommitContention: Boolean
    ): Exception {
        if (exhaustedOnCommitContention &&
            lastException is FirebaseFirestoreException &&
            lastException.code == FirebaseFirestoreException.Code.ABORTED
        ) {
            return FirebaseFirestoreException(
                message = lastException.message ?: "Transaction failed after $maxAttempts attempts",
                code = FirebaseFirestoreException.Code.FAILED_PRECONDITION,
                cause = lastException,
                denialContext = lastException.denialContext,
                wireCode = lastException.wireCode
            )
        }
        if (lastException != null) {
            return lastException
        }
        return FirebaseFirestoreException(
            "Transaction failed after $maxAttempts attempts",
            FirebaseFirestoreException.Code.FAILED_PRECONDITION
        )
    }

    internal fun addTerminationObserver(observer: () -> Unit): () -> Unit {
        val alreadyTerminated = synchronized(terminationLock) {
            if (isTerminated) {
                true
            } else {
                terminationObservers.add(observer)
                false
            }
        }
        if (alreadyTerminated) {
            observer()
            return {}
        }
        return {
            synchronized(terminationLock) {
                terminationObservers.remove(observer)
            }
        }
    }

    fun terminate(): Task<Void?> {
        val observers = synchronized(terminationLock) {
            if (isTerminated) {
                return Tasks.forResult(null)
            }
            isTerminated = true
            _terminatedStateFlow.value = true
            terminationObservers.toList().also { terminationObservers.clear() }
        }
        for (observer in observers) {
            runCatching { observer() }
        }
        unregisterDenialObserver()
        instances.remove(Pair(app.name, databaseId), this)
        rulesDenialListeners.forEach { it.active.set(false) }
        rulesDenialListeners.clear()
        offlineCoordinator.onTerminate()
        firestoreScope.cancel()
        if (!app.ownsSharedBridgeClient(bridgeClient)) {
            return bridgeClient.terminate()
        }
        return Tasks.forResult(null)
    }

    fun clearPersistence(): Task<Void?> = offlineCoordinator.clearPersistence()

    fun enableNetwork(): Task<Void?> = offlineCoordinator.enableNetwork()

    fun disableNetwork(): Task<Void?> = offlineCoordinator.disableNetwork()

    fun waitForPendingWrites(): Task<Void?> = offlineCoordinator.waitForPendingWrites()

    fun addSnapshotsInSyncListener(runnable: Runnable): ListenerRegistration =
        offlineCoordinator.addSnapshotsInSyncListener(executor = null, runnable = runnable)

    fun addSnapshotsInSyncListener(executor: Executor, runnable: Runnable): ListenerRegistration =
        offlineCoordinator.addSnapshotsInSyncListener(executor = executor, runnable = runnable)

    /**
     * The contention codes Android's TransactionRunner retries. Its rule also retries
     * every non-permanent code, but in pyric those come from the bridge itself (a lost
     * connection, a timeout, a close): a commit already sent may have been applied, so
     * it is never sent again (delivery contract D4). An app exception is never retried.
     */
    private fun isRetryableTransactionError(e: Exception): Boolean {
        val code = (e as? FirebaseFirestoreException)?.code ?: return false
        return code in RETRYABLE_TRANSACTION_CODES
    }

    companion object {
        private val RETRYABLE_TRANSACTION_CODES = setOf(
            FirebaseFirestoreException.Code.ABORTED,
            FirebaseFirestoreException.Code.ALREADY_EXISTS,
            FirebaseFirestoreException.Code.FAILED_PRECONDITION
        )

        private val instances = ConcurrentHashMap<Pair<String, String>, FirebaseFirestore>()

        @JvmStatic
        fun getInstance(): FirebaseFirestore =
            getInstance(FirebaseApp.getInstance(), "(default)")

        @JvmStatic
        fun getInstance(app: FirebaseApp): FirebaseFirestore =
            getInstance(app, "(default)")

        @JvmStatic
        fun getInstance(database: String): FirebaseFirestore =
            getInstance(FirebaseApp.getInstance(), database)

        @JvmStatic
        fun getInstance(app: FirebaseApp, database: String): FirebaseFirestore {
            return instances.computeIfAbsent(Pair(app.name, database)) {
                val bridge = app.getOrCreateBridgeClient()
                val auth = runCatching { FirebaseAuth.getInstance(app, bridge) }.getOrNull()
                FirebaseFirestore(bridge, app, database, credentialsProvider = auth)
            }
        }

        @JvmStatic
        fun getInstance(app: FirebaseApp, bridgeClient: PyricBridgeClient, database: String = "(default)"): FirebaseFirestore {
            return instances.computeIfAbsent(Pair(app.name, database)) {
                app.getOrCreateBridgeClient(bridgeClient)
                val auth = runCatching { FirebaseAuth.getInstance(app, bridgeClient) }.getOrNull()
                FirebaseFirestore(bridgeClient, app, database, credentialsProvider = auth)
            }
        }

        @JvmStatic
        fun clearInstancesForTest() {
            instances.clear()
            FirestoreOfflineCoordinator.clearAllPersistedStoresForTest()
        }
    }
}
