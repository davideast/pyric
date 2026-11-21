package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.TransactionOptions
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private fun toJsonStringList(items: List<String>): JSONArray {
    val arr = JSONArray()
    for (item in items) {
        arr.put(item)
    }
    return arr
}

private fun toJsonLongList(items: List<Long>): JSONArray {
    val arr = JSONArray()
    for (item in items) {
        arr.put(item)
    }
    return arr
}

private fun awaitFirestoreCollectionGroupRulesReady(
    db: FirebaseFirestore,
    collectionGroupId: String,
    timeoutMs: Long = 60_000L
) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    var consecutiveSuccesses = 0
    var lastError: Throwable? = null
    while (System.nanoTime() < deadline) {
        val attempt = runCatching {
            awaitFirebaseTask(
                db.collectionGroup(collectionGroupId).get(Source.SERVER),
                "fs.w5.cg.rulesReady",
                15_000L
            )
        }
        if (attempt.isSuccess) {
            consecutiveSuccesses += 1
            if (consecutiveSuccesses >= 3) {
                return
            }
            Thread.sleep(500)
        } else {
            val err = attempt.exceptionOrNull()
            lastError = err
            val fsErr = err as? FirebaseFirestoreException
            if (fsErr?.code != FirebaseFirestoreException.Code.PERMISSION_DENIED) {
                throw err ?: IllegalStateException("Unexpected collectionGroup readiness error")
            }
            consecutiveSuccesses = 0
            Thread.sleep(1_000)
        }
    }
    throw IllegalStateException(
        "Timed out waiting for Firestore collectionGroup('$collectionGroupId') rules propagation",
        lastError
    )
}

internal fun runFirestoreInequalityCursorsCollectionGroupAndTxRetryProbe(
    config: JSONObject
): JSONObject {
    RobolectricTlsSupport.install()
    FirebaseFirestore.setLoggingEnabled(true)
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val customToken = config.getString("customToken")
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .build()

    val primaryApp = FirebaseApp.initializeApp(context, options, "oracle-fs-w5-qtx-a-$runId")
    val contenderApp = FirebaseApp.initializeApp(context, options, "oracle-fs-w5-qtx-b-$runId")
    var primaryDb: FirebaseFirestore? = null
    var contenderDb: FirebaseFirestore? = null
    val cgId = "cg_$runId"
    val siblingCgId = "cg_other_$runId"

    try {
        val primaryAuth = FirebaseAuth.getInstance(primaryApp)
        val contenderAuth = FirebaseAuth.getInstance(contenderApp)
        awaitFirebaseTask(primaryAuth.signInWithCustomToken(customToken), "fs.w5.qtx.signInPrimary")
        awaitFirebaseTask(contenderAuth.signInWithCustomToken(customToken), "fs.w5.qtx.signInContender")

        val db = FirebaseFirestore.getInstance(primaryApp)
        val rivalDb = FirebaseFirestore.getInstance(contenderApp)
        primaryDb = db
        contenderDb = rivalDb

        val rootCgDocRef = db.document("$cgId/cg_root")
        try {
            val readinessRef = db.document("pyric_oracle/$runId/query_wave5_meta/readiness")
            awaitFirestoreWriteRulesReady(readinessRef, "fs.w5.qtx")
            awaitFirestoreCollectionGroupRulesReady(db, cgId)

            // 1. Seed 5 items for single-field inequality, not-in, value cursors, and DocumentSnapshot cursors
            val col = db.collection("pyric_oracle/$runId/query_wave5")
            val seedBatch = db.batch()
            seedBatch.set(col.document("d1"), mapOf("tier" to "bronze", "score" to 10L))
            seedBatch.set(col.document("d2"), mapOf("tier" to "silver", "score" to 20L))
            seedBatch.set(col.document("d3"), mapOf("tier" to "gold", "score" to 30L))
            seedBatch.set(col.document("d4"), mapOf("tier" to "platinum", "score" to 40L))
            seedBatch.set(col.document("d5"), mapOf("tier" to "diamond", "score" to 50L))
            awaitFirebaseTask(seedBatch.commit(), "fs.w5.qtx.seedBatch")

            // #22: whereNotEqualTo (implicit field-asc ordering + explicit numeric ordering)
            val notEqualTierSnap = awaitFirebaseTask(
                col.whereNotEqualTo("tier", "gold").get(Source.SERVER),
                "fs.w5.qtx.whereNotEqualToTier"
            )
            val notEqualScoreSnap = awaitFirebaseTask(
                col.whereNotEqualTo("score", 30L).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.w5.qtx.whereNotEqualToScore"
            )

            // #23: whereLessThan / whereLessThanOrEqualTo / whereGreaterThan / whereGreaterThanOrEqualTo
            val lessThanSnap = awaitFirebaseTask(
                col.whereLessThan("score", 30L).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.w5.qtx.whereLessThan"
            )
            val lessThanOrEqualSnap = awaitFirebaseTask(
                col.whereLessThanOrEqualTo("score", 30L).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.w5.qtx.whereLessThanOrEqualTo"
            )
            val greaterThanSnap = awaitFirebaseTask(
                col.whereGreaterThan("score", 30L).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.w5.qtx.whereGreaterThan"
            )
            val greaterThanOrEqualSnap = awaitFirebaseTask(
                col.whereGreaterThanOrEqualTo("score", 30L).orderBy("score", Query.Direction.ASCENDING).get(Source.SERVER),
                "fs.w5.qtx.whereGreaterThanOrEqualTo"
            )
            val openRangeDescSnap = awaitFirebaseTask(
                col.whereGreaterThan("score", 10L)
                    .whereLessThan("score", 50L)
                    .orderBy("score", Query.Direction.DESCENDING)
                    .get(Source.SERVER),
                "fs.w5.qtx.openRangeDesc"
            )

            // #27: whereNotIn
            val notInTierSnap = awaitFirebaseTask(
                col.whereNotIn("tier", listOf("bronze", "gold", "diamond")).get(Source.SERVER),
                "fs.w5.qtx.whereNotInTier"
            )
            val notInScoreSnap = awaitFirebaseTask(
                col.whereNotIn("score", listOf(10L, 50L))
                    .orderBy("score", Query.Direction.ASCENDING)
                    .get(Source.SERVER),
                "fs.w5.qtx.whereNotInScore"
            )

            // #32: startAt(values) / startAfter(values) / endAt(values) / endBefore(values)
            val startAtValuesLimitSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAt(20L)
                    .limit(2)
                    .get(Source.SERVER),
                "fs.w5.qtx.startAtValuesLimit"
            )
            val startAfterEndAtValuesSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAfter(20L)
                    .endAt(40L)
                    .get(Source.SERVER),
                "fs.w5.qtx.startAfterEndAtValues"
            )
            val descStartAfterEndBeforeValuesSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.DESCENDING)
                    .startAfter(40L)
                    .endBefore(10L)
                    .get(Source.SERVER),
                "fs.w5.qtx.descStartAfterEndBeforeValues"
            )

            // #34: startAt(DocumentSnapshot) / endAt(DocumentSnapshot) / startAfter(DocumentSnapshot) / endBefore(DocumentSnapshot)
            val snapD2 = awaitFirebaseTask(col.document("d2").get(Source.SERVER), "fs.w5.qtx.getD2")
            val snapD4 = awaitFirebaseTask(col.document("d4").get(Source.SERVER), "fs.w5.qtx.getD4")
            val startAtEndAtDocSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAt(snapD2)
                    .endAt(snapD4)
                    .get(Source.SERVER),
                "fs.w5.qtx.startAtEndAtDocSnap"
            )
            val startAfterEndBeforeDocSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.ASCENDING)
                    .startAfter(snapD2)
                    .endBefore(snapD4)
                    .get(Source.SERVER),
                "fs.w5.qtx.startAfterEndBeforeDocSnap"
            )
            val descStartAtEndAtDocSnap = awaitFirebaseTask(
                col.orderBy("score", Query.Direction.DESCENDING)
                    .startAt(snapD4)
                    .endAt(snapD2)
                    .get(Source.SERVER),
                "fs.w5.qtx.descStartAtEndAtDocSnap"
            )

            // #6: collectionGroup(collectionId) across nested subcollections + top-level collection + sibling isolation
            val cgEmptyThrowsIllegalArgument = runCatching {
                db.collectionGroup("")
            }.exceptionOrNull() is IllegalArgumentException
            val cgSlashThrowsIllegalArgument = runCatching {
                db.collectionGroup("invalid/slash")
            }.exceptionOrNull() is IllegalArgumentException

            val cgBatch = db.batch()
            cgBatch.set(
                db.document("pyric_oracle/$runId/orgs/org_a/$cgId/cg_org_a"),
                mapOf("origin" to "org_a", "rank" to 1L)
            )
            cgBatch.set(
                db.document("pyric_oracle/$runId/orgs/org_b/teams/team_x/$cgId/cg_team_x"),
                mapOf("origin" to "team_x", "rank" to 2L)
            )
            cgBatch.set(rootCgDocRef, mapOf("origin" to "root", "rank" to 3L))
            cgBatch.set(
                db.document("pyric_oracle/$runId/orgs/org_a/$siblingCgId/cg_ignored"),
                mapOf("origin" to "sibling", "rank" to 99L)
            )
            awaitFirebaseTask(cgBatch.commit(), "fs.w5.qtx.seedCollectionGroup")

            val cgSnap = awaitFirebaseTask(
                db.collectionGroup(cgId).get(Source.SERVER),
                "fs.w5.qtx.getCollectionGroup"
            )
            val cgIdsSorted = cgSnap.documents.map { it.id }.sorted()
            val cgRedactedPathsSorted = cgSnap.documents
                .map { it.reference.path.replace(runId, "<run>") }
                .sorted()

            val unscopedSiblingCgErr = runCatching {
                awaitFirebaseTask(
                    db.collectionGroup(siblingCgId).get(Source.SERVER),
                    "fs.w5.qtx.unscopedSiblingCg",
                    15_000L
                )
            }.exceptionOrNull() as? FirebaseFirestoreException

            // #8, #52, #53: runTransaction(TransactionOptions) + Transaction.delete + optimistic-lock retry & exhaustion
            val txInvalidMaxAttemptsThrowsIllegalArgument = runCatching {
                TransactionOptions.Builder().setMaxAttempts(0).build()
            }.exceptionOrNull() is IllegalArgumentException

            val retryPath = "pyric_oracle/$runId/tx_wave5/retry_counter"
            val deleteTargetPath = "pyric_oracle/$runId/tx_wave5/delete_in_tx"
            val retryRefA = db.document(retryPath)
            val retryRefB = rivalDb.document(retryPath)
            val deleteTargetRefA = db.document(deleteTargetPath)

            awaitFirebaseTask(retryRefA.set(mapOf("counter" to 0L)), "fs.w5.qtx.seedRetryCounter")
            awaitFirebaseTask(deleteTargetRefA.set(mapOf("ephemeral" to true)), "fs.w5.qtx.seedDeleteTarget")
            // Warm rivalDb gRPC channel before the contended transaction callback executes.
            awaitFirebaseTask(retryRefB.get(Source.SERVER), "fs.w5.qtx.warmRivalDb")

            val retryAttemptCount = AtomicInteger(0)
            val retryObservedCounters = CopyOnWriteArrayList<Long>()
            val retryCommittedValue = awaitFirebaseTask(
                db.runTransaction(
                    TransactionOptions.Builder().setMaxAttempts(3).build()
                ) { tx ->
                    val attempt = retryAttemptCount.incrementAndGet()
                    val current = tx.get(retryRefA).getLong("counter") ?: 0L
                    retryObservedCounters.add(current)
                    if (attempt == 1) {
                        Tasks.await(retryRefB.update("counter", 40L), 20, TimeUnit.SECONDS)
                    }
                    val updated = current + 2L
                    tx.update(retryRefA, "counter", updated)
                    tx.delete(deleteTargetRefA)
                    updated
                },
                "fs.w5.qtx.contendedRetryCommit",
                45_000L
            )
            val finalRetrySnap = awaitFirebaseTask(
                retryRefA.get(Source.SERVER),
                "fs.w5.qtx.getRetryAfterCommit"
            )
            val deleteTargetAfterCommitSnap = awaitFirebaseTask(
                deleteTargetRefA.get(Source.SERVER),
                "fs.w5.qtx.getDeleteTargetAfterCommit"
            )

            // Exhaustion with TransactionOptions.setMaxAttempts(1)
            val exhaustPath = "pyric_oracle/$runId/tx_wave5/exhaust_counter"
            val exhaustRefA = db.document(exhaustPath)
            val exhaustRefB = rivalDb.document(exhaustPath)
            awaitFirebaseTask(exhaustRefA.set(mapOf("counter" to 0L)), "fs.w5.qtx.seedExhaustCounter")

            val exhaustAttemptCount = AtomicInteger(0)
            val exhaustOutcome = runCatching {
                awaitFirebaseTask(
                    db.runTransaction(
                        TransactionOptions.Builder().setMaxAttempts(1).build()
                    ) { tx ->
                        exhaustAttemptCount.incrementAndGet()
                        val current = tx.get(exhaustRefA).getLong("counter") ?: 0L
                        Tasks.await(exhaustRefB.update("counter", 99L), 20, TimeUnit.SECONDS)
                        tx.update(exhaustRefA, "counter", current + 1L)
                        current + 1L
                    },
                    "fs.w5.qtx.contendedExhaustMaxAttempts1",
                    30_000L
                )
            }
            val exhaustErr = exhaustOutcome.exceptionOrNull() as? FirebaseFirestoreException
            val finalExhaustSnap = awaitFirebaseTask(
                exhaustRefA.get(Source.SERVER),
                "fs.w5.qtx.getExhaustAfterAbort"
            )

            return JSONObject()
                .put("whereNotEqualToTierIds", toJsonStringList(notEqualTierSnap.documents.map { it.id }))
                .put("whereNotEqualToScoreIds", toJsonStringList(notEqualScoreSnap.documents.map { it.id }))
                .put("whereLessThanIds", toJsonStringList(lessThanSnap.documents.map { it.id }))
                .put("whereLessThanOrEqualToIds", toJsonStringList(lessThanOrEqualSnap.documents.map { it.id }))
                .put("whereGreaterThanIds", toJsonStringList(greaterThanSnap.documents.map { it.id }))
                .put("whereGreaterThanOrEqualToIds", toJsonStringList(greaterThanOrEqualSnap.documents.map { it.id }))
                .put("openRangeDescIds", toJsonStringList(openRangeDescSnap.documents.map { it.id }))
                .put("whereNotInTierIds", toJsonStringList(notInTierSnap.documents.map { it.id }))
                .put("whereNotInScoreIds", toJsonStringList(notInScoreSnap.documents.map { it.id }))
                .put("cursorStartAtValuesLimit2Ids", toJsonStringList(startAtValuesLimitSnap.documents.map { it.id }))
                .put("cursorStartAfterEndAtValuesIds", toJsonStringList(startAfterEndAtValuesSnap.documents.map { it.id }))
                .put(
                    "cursorDescStartAfterEndBeforeValuesIds",
                    toJsonStringList(descStartAfterEndBeforeValuesSnap.documents.map { it.id })
                )
                .put("cursorStartAtEndAtDocSnapshotIds", toJsonStringList(startAtEndAtDocSnap.documents.map { it.id }))
                .put(
                    "cursorStartAfterEndBeforeDocSnapshotIds",
                    toJsonStringList(startAfterEndBeforeDocSnap.documents.map { it.id })
                )
                .put(
                    "cursorDescStartAtEndAtDocSnapshotIds",
                    toJsonStringList(descStartAtEndAtDocSnap.documents.map { it.id })
                )
                .put("collectionGroupEmptyThrowsIllegalArgument", cgEmptyThrowsIllegalArgument)
                .put("collectionGroupSlashThrowsIllegalArgument", cgSlashThrowsIllegalArgument)
                .put("collectionGroupIdsSorted", toJsonStringList(cgIdsSorted))
                .put("collectionGroupRedactedPathsSorted", toJsonStringList(cgRedactedPathsSorted))
                .put("collectionGroupUnscopedDeniedCodeName", unscopedSiblingCgErr?.code?.name)
                .put("txInvalidMaxAttemptsThrowsIllegalArgument", txInvalidMaxAttemptsThrowsIllegalArgument)
                .put("txRetryAttempts", retryAttemptCount.get())
                .put("txRetryObservedCounters", toJsonLongList(retryObservedCounters.toList()))
                .put("txRetryReturnCounter", retryCommittedValue)
                .put("txRetryFinalCounter", finalRetrySnap.getLong("counter"))
                .put("txDeletedTargetExistsAfterCommit", deleteTargetAfterCommitSnap.exists())
                .put("txExhaustedMaxAttempts", 1)
                .put("txExhaustedAttempts", exhaustAttemptCount.get())
                .put("txExhaustedThrew", exhaustOutcome.isFailure)
                .put("txExhaustedErrorCodeName", exhaustErr?.code?.name)
                .put("txExhaustedErrorCodeValue", exhaustErr?.code?.value())
                .put("txExhaustedFinalCounter", finalExhaustSnap.getLong("counter"))
        } finally {
            runCatching { awaitFirebaseTask(rootCgDocRef.delete(), "fs.w5.qtx.deleteRootCgDoc", 10_000L) }
            primaryAuth.signOut()
            contenderAuth.signOut()
        }
    } finally {
        shutdownFirebaseFirestoreAndApp(contenderDb, contenderApp)
        shutdownFirebaseFirestoreAndApp(primaryDb, primaryApp)
    }
}
