package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.AggregateField
import com.google.firebase.firestore.AggregateSource
import com.google.firebase.firestore.DocumentChange
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.Filter
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.PersistentCacheSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

private fun toJsonStringArray(items: List<String>): JSONArray {
    val arr = JSONArray()
    for (item in items) {
        arr.put(item)
    }
    return arr
}

internal fun runFirestoreQueriesCursorsListenersAndAggregationsProbe(
    config: JSONObject
): JSONObject {
    RobolectricTlsSupport.install()
    FirebaseFirestore.setLoggingEnabled(true)
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-fs-queries-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val app = FirebaseApp.initializeApp(context, options, appName)
    var firestore: FirebaseFirestore? = null
    try {
        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(config.getString("customToken")),
            "fs.queries.signInWithCustomToken"
        )

        val db = FirebaseFirestore.getInstance(app)
        firestore = db
        val col = db.collection("pyric_oracle").document(runId).collection("catalog")

        try {
            val seedBatch = db.batch()
            seedBatch.set(
                col.document("item_a"),
                mapOf("tier" to "bronze", "score" to 10L, "tags" to listOf("kotlin", "core"))
            )
            seedBatch.set(
                col.document("item_b"),
                mapOf("tier" to "silver", "score" to 20L, "tags" to listOf("kotlin", "ui"))
            )
            seedBatch.set(
                col.document("item_c"),
                mapOf("tier" to "gold", "score" to 30L, "tags" to listOf("swift", "cloud"))
            )
            seedBatch.set(
                col.document("item_d"),
                mapOf("tier" to "platinum", "score" to 40L, "tags" to listOf("rust", "edge"))
            )
            awaitFirebaseTask(seedBatch.commit(), "fs.queries.seedBatchCommit")

            val equalSnap = awaitFirebaseTask(
                col.whereEqualTo("tier", "gold").get(Source.SERVER),
                "fs.queries.whereEqualTo"
            )
            val rangeAscSnap = awaitFirebaseTask(
                col.where(
                    Filter.and(
                        Filter.greaterThanOrEqualTo("score", 20L),
                        Filter.lessThanOrEqualTo("score", 30L)
                    )
                ).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.queries.rangeFilterAnd"
            )
            val filterOrSnap = awaitFirebaseTask(
                col.where(
                    Filter.or(
                        Filter.equalTo("tier", "bronze"),
                        Filter.equalTo("tier", "platinum")
                    )
                ).get(Source.SERVER),
                "fs.queries.filterOr"
            )
            val whereInSnap = awaitFirebaseTask(
                col.whereIn("tier", listOf("silver", "gold")).get(Source.SERVER),
                "fs.queries.whereIn"
            )
            val arrayContainsSnap = awaitFirebaseTask(
                col.whereArrayContains("tags", "kotlin").get(Source.SERVER),
                "fs.queries.whereArrayContains"
            )
            val arrayContainsAnySnap = awaitFirebaseTask(
                col.whereArrayContainsAny("tags", listOf("swift", "rust")).get(Source.SERVER),
                "fs.queries.whereArrayContainsAny"
            )
            val descLimitSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.DESCENDING).limit(2).get(Source.SERVER),
                "fs.queries.descLimit2"
            )
            val ascLimitToLastSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING).limitToLast(2).get(Source.SERVER),
                "fs.queries.ascLimitToLast2"
            )

            val cursorBoundsSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAt(20L)
                    .endBefore(40L)
                    .get(Source.SERVER),
                "fs.queries.cursorBounds"
            )
            val docB = awaitFirebaseTask(
                col.document("item_b").get(Source.SERVER),
                "fs.queries.fetchCursorDocB"
            )
            val startAfterDocSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAfter(docB)
                    .limit(2)
                    .get(Source.SERVER),
                "fs.queries.startAfterDocSnap"
            )
            val docIdCursorSnap = awaitFirebaseTask(
                col.orderBy(FieldPath.documentId(), Query.Direction.ASCENDING)
                    .startAt("item_b")
                    .endAt("item_c")
                    .get(Source.SERVER),
                "fs.queries.docIdCursor"
            )

            // Aggregations on single-field query (score >= 20 -> 20 + 30 + 40 = 90, count = 3, avg = 30.0)
            val aggTarget = col.whereGreaterThanOrEqualTo("score", 20L)
            val countOnlySnap = awaitFirebaseTask(
                aggTarget.count().get(AggregateSource.SERVER),
                "fs.queries.countOnly"
            )
            val sumField = AggregateField.sum("score")
            val avgField = AggregateField.average("score")
            val multiAggSnap = awaitFirebaseTask(
                aggTarget.aggregate(AggregateField.count(), sumField, avgField)
                    .get(AggregateSource.SERVER),
                "fs.queries.multiAggregate"
            )
            val sumValue = (multiAggSnap.get(sumField) as? Number)?.toLong()
            val avgValue = multiAggSnap.getDouble(avgField)

            // Real-time snapshot listener + DocumentChange types + remove()
            val watchCol = db.collection("pyric_oracle").document(runId).collection("live_watch")
            awaitFirebaseTask(
                watchCol.document("w1").set(mapOf("step" to 1L)),
                "fs.queries.watchSeed"
            )

            val changeLog = CopyOnWriteArrayList<String>()
            var registration: ListenerRegistration? = null
            try {
                registration = watchCol
                    .orderBy("step", Query.Direction.ASCENDING)
                    .addSnapshotListener(MetadataChanges.EXCLUDE) { snapshot, error ->
                        if (error == null && snapshot != null) {
                            for (dc in snapshot.documentChanges) {
                                val kind = when (dc.type) {
                                    DocumentChange.Type.ADDED -> "ADDED"
                                    DocumentChange.Type.MODIFIED -> "MODIFIED"
                                    DocumentChange.Type.REMOVED -> "REMOVED"
                                }
                                changeLog.add("$kind:${dc.document.id}")
                            }
                        }
                    }

                awaitCondition("fs.queries.watchInitialAdded", 15_000L) {
                    changeLog.contains("ADDED:w1")
                }

                awaitFirebaseTask(
                    watchCol.document("w2").set(mapOf("step" to 2L)),
                    "fs.queries.watchAddW2"
                )
                awaitCondition("fs.queries.watchAddedW2", 15_000L) {
                    changeLog.contains("ADDED:w2")
                }

                awaitFirebaseTask(
                    watchCol.document("w1").update("step", 3L),
                    "fs.queries.watchModifyW1"
                )
                awaitCondition("fs.queries.watchModifiedW1", 15_000L) {
                    changeLog.contains("MODIFIED:w1")
                }

                awaitFirebaseTask(
                    watchCol.document("w2").delete(),
                    "fs.queries.watchDeleteW2"
                )
                awaitCondition("fs.queries.watchRemovedW2", 15_000L) {
                    changeLog.contains("REMOVED:w2")
                }

                registration.remove()
                registration = null
                val sizeAfterRemove = changeLog.size
                awaitFirebaseTask(
                    watchCol.document("w3").set(mapOf("step" to 4L)),
                    "fs.queries.watchWriteAfterUnsub"
                )
                Thread.sleep(250)
                pumpMainLooper()
                val quietAfterUnsubscribe = changeLog.size == sizeAfterRemove

                return JSONObject()
                    .put("equalToIds", toJsonStringArray(equalSnap.documents.map { it.id }))
                    .put("rangeFilterAndIds", toJsonStringArray(rangeAscSnap.documents.map { it.id }))
                    .put("filterOrIdsSorted", toJsonStringArray(filterOrSnap.documents.map { it.id }.sorted()))
                    .put("whereInIdsSorted", toJsonStringArray(whereInSnap.documents.map { it.id }.sorted()))
                    .put(
                        "arrayContainsIdsSorted",
                        toJsonStringArray(arrayContainsSnap.documents.map { it.id }.sorted())
                    )
                    .put(
                        "arrayContainsAnyIdsSorted",
                        toJsonStringArray(arrayContainsAnySnap.documents.map { it.id }.sorted())
                    )
                    .put("orderByDescLimit2Ids", toJsonStringArray(descLimitSnap.documents.map { it.id }))
                    .put("orderByAscLimitToLast2Ids", toJsonStringArray(ascLimitToLastSnap.documents.map { it.id }))
                    .put("cursorStartAtEndBeforeIds", toJsonStringArray(cursorBoundsSnap.documents.map { it.id }))
                    .put("startAfterDocumentSnapshotIds", toJsonStringArray(startAfterDocSnap.documents.map { it.id }))
                    .put("documentIdCursorIds", toJsonStringArray(docIdCursorSnap.documents.map { it.id }))
                    .put("countQueryCount", countOnlySnap.count)
                    .put("aggregateCount", multiAggSnap.count)
                    .put("aggregateSumScore", sumValue)
                    .put("aggregateAverageScore", avgValue)
                    .put("listenerDocumentChanges", toJsonStringArray(changeLog.toList()))
                    .put("listenerQuietAfterRemove", quietAfterUnsubscribe)
            } finally {
                registration?.remove()
            }
        } finally {
            auth.signOut()
        }
    } finally {
        shutdownFirebaseFirestoreAndApp(firestore, app)
    }
}

internal fun runFirestoreBatchesTransactionsOfflineAndErrorsProbe(
    config: JSONObject
): JSONObject {
    RobolectricTlsSupport.install()
    FirebaseFirestore.setLoggingEnabled(true)
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-fs-tx-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val app = FirebaseApp.initializeApp(context, options, appName)
    var firestore: FirebaseFirestore? = null
    try {
        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(config.getString("customToken")),
            "fs.tx.signInWithCustomToken"
        )

        val db = FirebaseFirestore.getInstance(app)
        firestore = db
        val settings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(PersistentCacheSettings.newBuilder().build())
            .build()
        db.firestoreSettings = settings

        val col = db.collection("pyric_oracle").document(runId).collection("tx_batch")

        val activeClearErr: Throwable?
        val deniedErrorCodeName: String?
        val deniedErrorCodeValue: Int?
        val offlineServerErrorCodeName: String?
        val batchItem1Score: Long?
        val batchItem1Merged: Boolean
        val batchDeletedExists: Boolean
        val txReturnBalance: Long
        val txReceiptAmount: Long?
        val txAbortedRejected: Boolean
        val txBalanceAfterAbort: Long?
        val offlineCachedPending: Boolean
        val offlineCachedFromCache: Boolean
        val flushedServerPending: Boolean
        val flushedServerFromCache: Boolean

        try {
            // 1. Atomic WriteBatch (set + set merge + update + delete)
            val scratchRef = col.document("scratch_delete")
            awaitFirebaseTask(scratchRef.set(mapOf("temp" to true)), "fs.tx.seedScratch")

            val item1Ref = col.document("batch_1")
            val batch = db.batch()
            batch.set(item1Ref, mapOf("score" to 10L, "label" to "one"))
            batch.set(item1Ref, mapOf("mergedBatch" to true), SetOptions.merge())
            batch.update(item1Ref, "score", 25L)
            batch.delete(scratchRef)
            awaitFirebaseTask(batch.commit(), "fs.tx.batchCommit")

            val item1Snap = awaitFirebaseTask(item1Ref.get(Source.SERVER), "fs.tx.item1Get")
            val scratchSnap = awaitFirebaseTask(scratchRef.get(Source.SERVER), "fs.tx.scratchGet")
            batchItem1Score = item1Snap.getLong("score")
            batchItem1Merged = item1Snap.getBoolean("mergedBatch") == true
            batchDeletedExists = scratchSnap.exists()

            // 2. runTransaction commit + abort rollback
            val accountRef = col.document("account")
            val receiptRef = col.document("tx_receipt")
            awaitFirebaseTask(accountRef.set(mapOf("balance" to 100L)), "fs.tx.seedAccount")

            txReturnBalance = awaitFirebaseTask(
                db.runTransaction { tx ->
                    val current = tx.get(accountRef).getLong("balance") ?: 0L
                    val updated = current + 45L
                    tx.update(accountRef, "balance", updated)
                    tx.set(receiptRef, mapOf("recordedBalance" to updated))
                    updated
                },
                "fs.tx.runTransactionCommit"
            )
            val receiptSnap = awaitFirebaseTask(receiptRef.get(Source.SERVER), "fs.tx.receiptGet")
            txReceiptAmount = receiptSnap.getLong("recordedBalance")

            val abortOutcome = runCatching {
                awaitFirebaseTask(
                    db.runTransaction<Unit> { tx ->
                        val current = tx.get(accountRef).getLong("balance") ?: 0L
                        tx.update(accountRef, "balance", current + 500L)
                        throw IllegalStateException("deliberate-transaction-abort")
                    },
                    "fs.tx.runTransactionAbort"
                )
            }
            txAbortedRejected = abortOutcome.isFailure
            val afterAbortSnap = awaitFirebaseTask(
                accountRef.get(Source.SERVER),
                "fs.tx.accountGetAfterAbort"
            )
            txBalanceAfterAbort = afterAbortSnap.getLong("balance")

            // 3. Offline staging + Source.CACHE / Source.SERVER UNAVAILABLE + enableNetwork + waitForPendingWrites
            val offlineDocRef = col.document("offline_staged")
            awaitFirebaseTask(db.disableNetwork(), "fs.tx.disableNetwork")
            offlineDocRef.set(mapOf("stage" to "queued-offline", "seq" to 7L))

            var cachedOfflineSnap = awaitFirebaseTask(
                offlineDocRef.get(Source.CACHE),
                "fs.tx.offlineGetCache"
            )
            val cacheDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!cachedOfflineSnap.exists() && System.nanoTime() < cacheDeadline) {
                Thread.sleep(20)
                cachedOfflineSnap = awaitFirebaseTask(
                    offlineDocRef.get(Source.CACHE),
                    "fs.tx.offlineGetCachePoll"
                )
            }
            offlineCachedPending = cachedOfflineSnap.metadata.hasPendingWrites()
            offlineCachedFromCache = cachedOfflineSnap.metadata.isFromCache

            val serverOfflineErr = runCatching {
                awaitFirebaseTask(
                    offlineDocRef.get(Source.SERVER),
                    "fs.tx.offlineGetServer",
                    10_000L
                )
            }.exceptionOrNull() as? FirebaseFirestoreException
            offlineServerErrorCodeName = serverOfflineErr?.code?.name

            awaitFirebaseTask(db.enableNetwork(), "fs.tx.enableNetwork")
            awaitFirebaseTask(db.waitForPendingWrites(), "fs.tx.waitForPendingWrites")

            val flushedServerSnap = awaitFirebaseTask(
                offlineDocRef.get(Source.SERVER),
                "fs.tx.flushedGetServer"
            )
            flushedServerPending = flushedServerSnap.metadata.hasPendingWrites()
            flushedServerFromCache = flushedServerSnap.metadata.isFromCache

            // 4. Security Rules PERMISSION_DENIED outside pyric_oracle/<runId>
            val deniedRef = db.collection("pyric_oracle_denied")
                .document(runId)
                .collection("forbidden")
                .document("doc1")
            val deniedErr = runCatching {
                awaitFirebaseTask(deniedRef.get(Source.SERVER), "fs.tx.deniedGet", 15_000L)
            }.exceptionOrNull() as? FirebaseFirestoreException
            deniedErrorCodeName = deniedErr?.code?.name
            deniedErrorCodeValue = deniedErr?.code?.value()

            // 5. clearPersistence while active rejects with FAILED_PRECONDITION, then succeeds after terminate()
            activeClearErr = runCatching {
                awaitFirebaseTask(db.clearPersistence(), "fs.tx.clearActive", 10_000L)
            }.exceptionOrNull()
        } finally {
            auth.signOut()
        }

        awaitFirebaseTask(db.terminate(), "fs.tx.terminate", 10_000L)
        firestore = null
        val clearAfterTerminateSucceeded = runCatching {
            awaitFirebaseTask(db.clearPersistence(), "fs.tx.clearAfterTerminate", 10_000L)
        }.isSuccess
        val activeClearFsErr = activeClearErr as? FirebaseFirestoreException

        return JSONObject()
            .put("batchItemScore", batchItem1Score)
            .put("batchItemMergedFlag", batchItem1Merged)
            .put("batchDeletedDocExists", batchDeletedExists)
            .put("transactionReturnBalance", txReturnBalance)
            .put("transactionReceiptBalance", txReceiptAmount)
            .put("transactionAbortRejected", txAbortedRejected)
            .put("balanceUnchangedAfterAbort", txBalanceAfterAbort)
            .put("offlineCacheHasPendingWrites", offlineCachedPending)
            .put("offlineCacheIsFromCache", offlineCachedFromCache)
            .put("offlineServerReadErrorCode", offlineServerErrorCodeName)
            .put("flushedServerHasPendingWrites", flushedServerPending)
            .put("flushedServerIsFromCache", flushedServerFromCache)
            .put("permissionDeniedCodeName", deniedErrorCodeName)
            .put("permissionDeniedCodeValue", deniedErrorCodeValue)
            .put("clearPersistenceWhileActiveCodeName", activeClearFsErr?.code?.name)
            .put("clearPersistenceAfterTerminateSucceeded", clearAfterTerminateSucceeded)
    } finally {
        shutdownFirebaseFirestoreAndApp(firestore, app)
    }
}

private fun awaitCondition(label: String, timeoutMs: Long, predicate: () -> Boolean) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    while (System.nanoTime() < deadline) {
        pumpMainLooper()
        if (predicate()) {
            return
        }
        Thread.sleep(15)
    }
    pumpMainLooper()
    if (!predicate()) {
        throw java.util.concurrent.TimeoutException(
            "Timed out waiting for Firestore condition '$label' after ${timeoutMs}ms"
        )
    }
}
