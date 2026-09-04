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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

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

    private val firestoreScope = CoroutineScope(Dispatchers.IO)
    private val rulesDenialListeners = CopyOnWriteArrayList<RulesDenialListener>()

    init {
        firestoreScope.launch {
            bridgeClient.denialEvents.collect { exception ->
                notifyRulesDenial(exception)
            }
        }
    }

    var firestoreSettings: FirebaseFirestoreSettings = FirebaseFirestoreSettings.Builder().build()

    fun addRulesDenialListener(listener: RulesDenialListener): ListenerRegistration {
        rulesDenialListeners.add(listener)
        return ListenerRegistration {
            rulesDenialListeners.remove(listener)
        }
    }

    fun removeRulesDenialListener(listener: RulesDenialListener) {
        rulesDenialListeners.remove(listener)
    }

    fun notifyRulesDenial(exception: FirebaseFirestoreException) {
        if (exception.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) {
            @Suppress("UNCHECKED_CAST")
            val contextMap = (exception.denialContext as? Map<String, Any?>) ?: emptyMap()
            for (listener in rulesDenialListeners) {
                try {
                    listener.onDenial(exception, contextMap)
                } catch (_: Throwable) {}
            }
        }
    }

    fun getEffectiveAuthLens(): AuthLens =
        credentialsProvider?.getEffectiveLens() ?: AuthLens.Anon

    val authLensFlow: StateFlow<AuthLens>
        get() = credentialsProvider?.authLensFlow ?: MutableStateFlow(AuthLens.Anon)

    fun collection(collectionPath: String): CollectionReference {
        val segments = collectionPath.trim('/').split('/').filter { it.isNotEmpty() }
        require(segments.size % 2 == 1) {
            "Invalid collection reference. Collection references must have an odd number of segments, but $collectionPath has ${segments.size}"
        }
        return CollectionReference(this, collectionPath.trim('/'))
    }

    fun document(documentPath: String): DocumentReference {
        val segments = documentPath.trim('/').split('/').filter { it.isNotEmpty() }
        require(segments.size % 2 == 0) {
            "Invalid document reference. Document references must have an even number of segments, but $documentPath has ${segments.size}"
        }
        return DocumentReference(this, documentPath.trim('/'))
    }

    fun collectionGroup(collectionId: String): Query {
        require(!collectionId.contains('/')) {
            "Invalid collectionId '$collectionId'. Collection IDs must not contain '/'."
        }
        return Query(this, collectionId = collectionId, isCollectionGroup = true)
    }

    fun batch(): WriteBatch = WriteBatch(this)

    fun runBatch(batchFunction: WriteBatch.Function): Task<Void?> {
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
        val tcs = TaskCompletionSource<TResult>()
        val scope = CoroutineScope(Dispatchers.IO)

        scope.launch {
            var lastException: Exception? = null
            for (attempt in 1..options.maxAttempts) {
                try {
                    val txn = Transaction(this@FirebaseFirestore)
                    val result = updateFunction.apply(txn)
                    bridgeClient.op(
                        method = "txnCommit",
                        params = mapOf(
                            "reads" to txn.reads,
                            "writes" to txn.writes
                        ),
                        actAs = getEffectiveAuthLens().toMap()
                    )
                    tcs.setResult(result)
                    return@launch
                } catch (e: Exception) {
                    lastException = e
                }
            }
            tcs.setException(
                lastException ?: FirebaseFirestoreException(
                    "Transaction failed after ${options.maxAttempts} attempts",
                    FirebaseFirestoreException.Code.ABORTED
                )
            )
        }

        return tcs.task
    }

    fun terminate(): Task<Void?> {
        firestoreScope.cancel()
        return bridgeClient.terminate()
    }

    fun clearPersistence(): Task<Void?> = Tasks.forResult(null)

    fun enableNetwork(): Task<Void?> = Tasks.forResult(null)

    fun disableNetwork(): Task<Void?> = Tasks.forResult(null)

    fun waitForPendingWrites(): Task<Void?> = Tasks.forResult(null)

    fun addSnapshotsInSyncListener(runnable: Runnable): ListenerRegistration {
        return ListenerRegistration {}
    }

    companion object {
        private val instances = ConcurrentHashMap<Pair<String, String>, FirebaseFirestore>()

        fun getInstance(): FirebaseFirestore =
            getInstance(FirebaseApp.getInstance(), "(default)")

        fun getInstance(app: FirebaseApp): FirebaseFirestore =
            getInstance(app, "(default)")

        fun getInstance(database: String): FirebaseFirestore =
            getInstance(FirebaseApp.getInstance(), database)

        fun getInstance(app: FirebaseApp, database: String): FirebaseFirestore {
            return instances.computeIfAbsent(Pair(app.name, database)) {
                val bridge = PyricBridgeClient.createDefault()
                val auth = runCatching { FirebaseAuth.getInstance(app, bridge) }.getOrNull()
                FirebaseFirestore(bridge, app, database, credentialsProvider = auth)
            }
        }

        fun getInstance(app: FirebaseApp, bridgeClient: PyricBridgeClient, database: String = "(default)"): FirebaseFirestore {
            return instances.computeIfAbsent(Pair(app.name, database)) {
                val auth = runCatching { FirebaseAuth.getInstance(app, bridgeClient) }.getOrNull()
                FirebaseFirestore(bridgeClient, app, database, credentialsProvider = auth)
            }
        }

        fun clearInstancesForTest() {
            instances.clear()
        }
    }
}
