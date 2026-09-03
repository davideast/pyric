package com.google.firebase.firestore

import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.TaskCompletionSource
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import dev.pyric.bridge.PyricBridgeClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

class FirebaseFirestore internal constructor(
    val bridgeClient: PyricBridgeClient,
    val app: FirebaseApp,
    val databaseId: String
) {
    var firestoreSettings: FirebaseFirestoreSettings = FirebaseFirestoreSettings.Builder().build()

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
                        )
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

    fun terminate(): Task<Void?> = bridgeClient.terminate()

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
                FirebaseFirestore(bridge, app, database)
            }
        }

        fun clearInstancesForTest() {
            instances.clear()
        }
    }
}
