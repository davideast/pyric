package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.ChildEventListener
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.Logger
import com.google.firebase.database.MutableData
import com.google.firebase.database.Transaction
import com.google.firebase.database.ValueEventListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

private data class RtdbTxOutcome(
    val error: DatabaseError?,
    val committed: Boolean,
    val finalValue: Long?
)

internal fun runRtdbListenersTransactionsConnectionAndOnDisconnectProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val databaseUrl = config.getString("databaseUrl")
    val customToken = config.getString("customToken")
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .setDatabaseUrl(databaseUrl)
        .build()

    val app = FirebaseApp.initializeApp(context, options, "oracle-rtdb-live-$runId")
    var db: FirebaseDatabase? = null
    try {
        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(customToken),
            "rtdb.live.signInWithCustomToken"
        )

        val database = FirebaseDatabase.getInstance(app, databaseUrl)
        db = database
        runCatching { database.setLogLevel(Logger.Level.DEBUG) }
        database.goOnline()

        val connectedRef = database.getReference(".info/connected")
        val offsetRef = database.getReference(".info/serverTimeOffset")
        val connectedTransitions = CopyOnWriteArrayList<Boolean>()
        val observedOffsetClass = AtomicReference<String?>(null)

        val connectedListener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                val state = snapshot.getValue(Boolean::class.java) ?: return
                if (connectedTransitions.lastOrNull() != state) {
                    connectedTransitions.add(state)
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        }
        val offsetListener = object : ValueEventListener {
            override fun onDataChange(snapshot: DataSnapshot) {
                if (snapshot.value != null) {
                    observedOffsetClass.set(snapshot.value?.javaClass?.name)
                }
            }

            override fun onCancelled(error: DatabaseError) {}
        }

        connectedRef.addValueEventListener(connectedListener)
        offsetRef.addValueEventListener(offsetListener)
        val baseRef = database.getReference("pyric_oracle/$runId/rtdb_kotlin")

        try {
            // Trigger outbound connection handshake if idle and wait for .info/connected == true.
            awaitFirebaseTask(baseRef.child("handshake_ping").setValue("ready"), "rtdb.live.handshakePing")
            awaitMainLooperCondition("rtdb.live.connectedInitialTrue") {
                connectedTransitions.contains(true) && observedOffsetClass.get() != null
            }

            database.goOffline()
            awaitMainLooperCondition("rtdb.live.connectedOfflineFalse") {
                connectedTransitions.lastOrNull() == false
            }

            database.goOnline()
            awaitMainLooperCondition("rtdb.live.connectedReconnectedTrue") {
                connectedTransitions.size >= 3 && connectedTransitions.lastOrNull() == true
            }

            connectedRef.removeEventListener(connectedListener)
            offsetRef.removeEventListener(offsetListener)

            val watchRef = baseRef.child("watched_scores")
            awaitFirebaseTask(
                watchRef.setValue(mapOf("a" to 1L, "b" to 2L)),
                "rtdb.live.seedWatch"
            )

            val valueCounts = CopyOnWriteArrayList<Long>()
            val childTimeline = CopyOnWriteArrayList<String>()
            val orderedWatch = watchRef.orderByValue()

            val valueListener = object : ValueEventListener {
                override fun onDataChange(snapshot: DataSnapshot) {
                    valueCounts.add(snapshot.childrenCount)
                }

                override fun onCancelled(error: DatabaseError) {}
            }
            val childListener = object : ChildEventListener {
                override fun onChildAdded(snapshot: DataSnapshot, previousChildName: String?) {
                    childTimeline.add("added:${snapshot.key}:prev=${previousChildName ?: "null"}")
                }

                override fun onChildChanged(snapshot: DataSnapshot, previousChildName: String?) {
                    val v = (snapshot.value as? Number)?.toLong()
                    childTimeline.add("changed:${snapshot.key}:$v")
                }

                override fun onChildRemoved(snapshot: DataSnapshot) {
                    val v = (snapshot.value as? Number)?.toLong()
                    childTimeline.add("removed:${snapshot.key}:$v")
                }

                override fun onChildMoved(snapshot: DataSnapshot, previousChildName: String?) {
                    childTimeline.add("moved:${snapshot.key}:prev=${previousChildName ?: "null"}")
                }

                override fun onCancelled(error: DatabaseError) {}
            }

            watchRef.addValueEventListener(valueListener)
            orderedWatch.addChildEventListener(childListener)
            try {
                awaitMainLooperCondition("rtdb.live.initialWatchEvents") {
                    valueCounts.isNotEmpty() && childTimeline.size >= 2
                }

                awaitFirebaseTask(watchRef.child("c").setValue(3L), "rtdb.live.watchAddC")
                awaitMainLooperCondition("rtdb.live.watchAddedC") {
                    childTimeline.contains("added:c:prev=b")
                }

                awaitFirebaseTask(watchRef.child("a").setValue(10L), "rtdb.live.watchUpdateMoveA")
                awaitMainLooperCondition("rtdb.live.watchChangedMovedA") {
                    childTimeline.contains("changed:a:10") && childTimeline.contains("moved:a:prev=c")
                }

                awaitFirebaseTask(watchRef.child("b").removeValue(), "rtdb.live.watchRemoveB")
                awaitMainLooperCondition("rtdb.live.watchRemovedB") {
                    childTimeline.contains("removed:b:2")
                }

                watchRef.removeEventListener(valueListener)
                orderedWatch.removeEventListener(childListener)
                val valueEventsAtUnsub = valueCounts.size
                val childEventsAtUnsub = childTimeline.size

                awaitFirebaseTask(watchRef.child("d").setValue(4L), "rtdb.live.watchWriteAfterUnsub")
                awaitFirebaseTask(watchRef.get(), "rtdb.live.watchFenceGet")
                pumpMainLooper()
                val silentAfterRemoveListener =
                    valueCounts.size == valueEventsAtUnsub && childTimeline.size == childEventsAtUnsub

                val txRef = baseRef.child("tx_counter")
                awaitFirebaseTask(txRef.setValue(10L), "rtdb.live.seedTx")

                val commitOutcome = AtomicReference<RtdbTxOutcome?>(null)
                txRef.runTransaction(
                    object : Transaction.Handler {
                        override fun doTransaction(currentData: MutableData): Transaction.Result {
                            val current = currentData.getValue(Long::class.java) ?: 0L
                            currentData.value = current + 7L
                            return Transaction.success(currentData)
                        }

                        override fun onComplete(
                            error: DatabaseError?,
                            committed: Boolean,
                            currentData: DataSnapshot?
                        ) {
                            commitOutcome.set(
                                RtdbTxOutcome(
                                    error = error,
                                    committed = committed,
                                    finalValue = currentData?.getValue(Long::class.java)
                                )
                            )
                        }
                    }
                )
                awaitMainLooperCondition("rtdb.live.txCommit") { commitOutcome.get() != null }
                val committedTx = requireNotNull(commitOutcome.get())

                val abortOutcome = AtomicReference<RtdbTxOutcome?>(null)
                txRef.runTransaction(
                    object : Transaction.Handler {
                        override fun doTransaction(currentData: MutableData): Transaction.Result {
                            currentData.value = 999L
                            return Transaction.abort()
                        }

                        override fun onComplete(
                            error: DatabaseError?,
                            committed: Boolean,
                            currentData: DataSnapshot?
                        ) {
                            abortOutcome.set(
                                RtdbTxOutcome(
                                    error = error,
                                    committed = committed,
                                    finalValue = currentData?.getValue(Long::class.java)
                                )
                            )
                        }
                    }
                )
                awaitMainLooperCondition("rtdb.live.txAbort") { abortOutcome.get() != null }
                val abortedTx = requireNotNull(abortOutcome.get())
                val txServerAfterAbort = awaitFirebaseTask(txRef.get(), "rtdb.live.txGetAfterAbort")
                    .getValue(Long::class.java)

                val onDisconnectResult = runTwoAppOnDisconnectVerification(
                    context = context,
                    options = options,
                    databaseUrl = databaseUrl,
                    customToken = customToken,
                    runId = runId,
                    observerBaseRef = baseRef
                )

                val connectedIndexTrue = connectedTransitions.indexOf(true)
                val connectedSawToggle =
                    connectedIndexTrue >= 0 &&
                        connectedTransitions.drop(connectedIndexTrue + 1).contains(false) &&
                        connectedTransitions.lastOrNull() == true

                return JSONObject()
                    .put("infoConnectedToggleTrueFalseTrue", connectedSawToggle)
                    .put("infoServerTimeOffsetClass", observedOffsetClass.get())
                    .put("valueListenerInitialCount", valueCounts.firstOrNull())
                    .put("valueListenerObservedMutations", valueCounts.size >= 3)
                    .put("childTimeline", JSONArray(childTimeline))
                    .put("silentAfterRemoveEventListener", silentAfterRemoveListener)
                    .put("txCommitErrorNull", committedTx.error == null)
                    .put("txCommitCommitted", committedTx.committed)
                    .put("txCommitFinalValue", committedTx.finalValue)
                    .put("txAbortErrorNull", abortedTx.error == null)
                    .put("txAbortCommitted", abortedTx.committed)
                    .put("txServerValueAfterAbort", txServerAfterAbort)
                    .put("onDisconnect", onDisconnectResult)
            } finally {
                watchRef.removeEventListener(valueListener)
                orderedWatch.removeEventListener(childListener)
            }
        } finally {
            connectedRef.removeEventListener(connectedListener)
            offsetRef.removeEventListener(offsetListener)
            runCatching {
                awaitFirebaseTask(baseRef.removeValue(), "rtdb.live.cleanup", 10_000L)
            }
            auth.signOut()
        }
    } finally {
        shutdownFirebaseDatabaseAndApp(db, app)
    }
}

private fun runTwoAppOnDisconnectVerification(
    context: Context,
    options: FirebaseOptions,
    databaseUrl: String,
    customToken: String,
    runId: String,
    observerBaseRef: com.google.firebase.database.DatabaseReference
): JSONObject {
    val presenceStatusRef = observerBaseRef.child("presence/status")
    val ephemeralRef = observerBaseRef.child("presence/ephemeral_session")
    val canceledRef = observerBaseRef.child("presence/kept_after_cancel")

    awaitFirebaseTask(presenceStatusRef.setValue("online"), "rtdb.ondisconnect.seedStatus")
    awaitFirebaseTask(ephemeralRef.setValue("active-ephemeral"), "rtdb.ondisconnect.seedEphemeral")
    awaitFirebaseTask(canceledRef.setValue("kept-alive"), "rtdb.ondisconnect.seedCanceled")

    val writerApp = FirebaseApp.initializeApp(context, options, "oracle-rtdb-writer-$runId")
    var writerDb: FirebaseDatabase? = null
    try {
        val writerAuth = FirebaseAuth.getInstance(writerApp)
        awaitFirebaseTask(
            writerAuth.signInWithCustomToken(customToken),
            "rtdb.ondisconnect.writerSignIn"
        )
        val wdb = FirebaseDatabase.getInstance(writerApp, databaseUrl)
        writerDb = wdb
        wdb.goOnline()

        val writerBase = wdb.getReference("pyric_oracle/$runId/rtdb_kotlin/presence")
        awaitFirebaseTask(
            writerBase.child("status").onDisconnect().setValue("offline-by-ondisconnect"),
            "rtdb.ondisconnect.queueSetValue"
        )
        awaitFirebaseTask(
            writerBase.child("ephemeral_session").onDisconnect().removeValue(),
            "rtdb.ondisconnect.queueRemoveValue"
        )
        awaitFirebaseTask(
            writerBase.child("kept_after_cancel").onDisconnect().setValue("must-not-run"),
            "rtdb.ondisconnect.queueCanceledSet"
        )
        awaitFirebaseTask(
            writerBase.child("kept_after_cancel").onDisconnect().cancel(),
            "rtdb.ondisconnect.cancelQueuedSet"
        )

        wdb.goOffline()
        pumpMainLooper()
    } finally {
        shutdownFirebaseDatabaseAndApp(writerDb, writerApp)
    }

    var observedStatus = awaitFirebaseTask(presenceStatusRef.get(), "rtdb.ondisconnect.pollInitial")
        .getValue(String::class.java)
    val deadline = System.nanoTime() + 15_000_000_000L
    while (observedStatus != "offline-by-ondisconnect" && System.nanoTime() < deadline) {
        Thread.sleep(100)
        observedStatus = awaitFirebaseTask(presenceStatusRef.get(), "rtdb.ondisconnect.pollStatus")
            .getValue(String::class.java)
    }

    val ephemeralAfterSnap = awaitFirebaseTask(ephemeralRef.get(), "rtdb.ondisconnect.getEphemeralAfter")
    val canceledAfterSnap = awaitFirebaseTask(canceledRef.get(), "rtdb.ondisconnect.getCanceledAfter")

    return JSONObject()
        .put("statusAfterDisconnect", observedStatus)
        .put("ephemeralExistsAfterDisconnect", ephemeralAfterSnap.exists())
        .put("canceledPathValueAfterDisconnect", canceledAfterSnap.getValue(String::class.java))
}
