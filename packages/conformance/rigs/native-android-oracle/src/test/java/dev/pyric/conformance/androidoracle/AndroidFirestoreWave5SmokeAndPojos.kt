package dev.pyric.conformance.androidoracle

import android.content.Context
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.PersistentCacheSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.TransactionOptions
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.firestoreSettings
import com.google.firebase.firestore.memoryCacheSettings
import com.google.firebase.firestore.persistentCacheSettings
import com.google.firebase.firestore.snapshots
import com.google.firebase.firestore.toObject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class OracleBadgePojo(
    var code: String = "",
    var tier: Long = 0L
)

class OracleProfilePojo(
    var handle: String = "",
    var level: Long = 0L,
    var score: Double = 0.0,
    var active: Boolean = false,
    var tags: List<String> = emptyList(),
    var counters: Map<String, Long> = emptyMap(),
    var primaryBadge: OracleBadgePojo? = null
) {
    @field:DocumentId
    var docId: String = ""
}

internal fun awaitFirestoreWriteRulesReady(
    probeRef: DocumentReference,
    label: String,
    timeoutMs: Long = 60_000L
) {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    var consecutiveSuccesses = 0
    var lastError: Throwable? = null
    while (System.nanoTime() < deadline) {
        val attempt = runCatching {
            awaitFirebaseTask(probeRef.set(mapOf("ready" to true)), "$label.writeReady", 15_000L)
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
                throw err ?: IllegalStateException("Unexpected Firestore readiness error in $label")
            }
            consecutiveSuccesses = 0
            Thread.sleep(1_000)
        }
    }
    throw IllegalStateException(
        "Timed out waiting for Firestore security rules readiness in $label",
        lastError
    )
}

internal fun verifyLocalRobolectricFirestoreWave5Smoke(context: Context) {
    val options = FirebaseOptions.Builder()
        .setProjectId("demo-robolectric-oracle")
        .setApplicationId("1:123456789000:android:abcdef012345")
        .setApiKey("AIzaSyDemoRobolectricSmokeKey00000000000")
        .build()

    var defaultApp: FirebaseApp? = null
    var defaultDb: FirebaseFirestore? = null
    val namedAppName = "pyric-robolectric-fs-wave5-${System.nanoTime()}"
    val namedApp = FirebaseApp.initializeApp(context, options, namedAppName)
    var namedDb: FirebaseFirestore? = null
    val executor = Executors.newSingleThreadExecutor()
    val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())

    try {
        val existingDefault = FirebaseApp.getApps(context)
            .firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        val resolvedDefaultApp = existingDefault ?: FirebaseApp.initializeApp(context, options).also {
            defaultApp = it
        }
        val dbDefault = FirebaseFirestore.getInstance()
        defaultDb = dbDefault
        assertSame(dbDefault, Firebase.firestore)
        assertEquals(resolvedDefaultApp.name, dbDefault.app.name)

        val db = FirebaseFirestore.getInstance(namedApp)
        namedDb = db
        assertSame(db, Firebase.firestore(namedApp))
        assertTrue(db !== dbDefault)

        val customSettings = firestoreSettings {
            setLocalCacheSettings(
                persistentCacheSettings {
                    setSizeBytes(16L * 1024L * 1024L)
                }
            )
        }
        db.firestoreSettings = customSettings
        assertEquals("firestore.googleapis.com", db.firestoreSettings.host)
        assertTrue(db.firestoreSettings.isSslEnabled)
        assertTrue(db.firestoreSettings.cacheSettings is PersistentCacheSettings)

        awaitFirebaseTask(db.disableNetwork(), "fs.wave5.smoke.disableNetwork", 10_000L)

        val settingsReconfigErr = runCatching {
            db.firestoreSettings = firestoreSettings {
                host = "127.0.0.1:9090"
                isSslEnabled = false
                setLocalCacheSettings(memoryCacheSettings {})
            }
        }.exceptionOrNull()
        assertTrue(settingsReconfigErr is IllegalStateException)

        val oddPathErr = runCatching { db.document("pyric_oracle/smoke_w5/odd_col") }.exceptionOrNull()
        assertTrue(oddPathErr is IllegalArgumentException)
        val cgSlashErr = runCatching { db.collectionGroup("bad/group") }.exceptionOrNull()
        assertTrue(cgSlashErr is IllegalArgumentException)
        val badMaxAttemptsErr = runCatching {
            TransactionOptions.Builder().setMaxAttempts(0).build()
        }.exceptionOrNull()
        assertTrue(badMaxAttemptsErr is IllegalArgumentException)

        val directRef = db.document("pyric_oracle/smoke_w5/profiles/ada")
        assertEquals("ada", directRef.id)
        assertEquals("profiles", directRef.parent.id)

        val inSyncCounter = AtomicInteger(0)
        val inSyncReg = db.addSnapshotsInSyncListener { inSyncCounter.incrementAndGet() }

        val emittedStages = CopyOnWriteArrayList<String>()
        val flowJob: Job = scope.launch {
            directRef.snapshots(MetadataChanges.INCLUDE).collect { snap ->
                if (snap.exists()) {
                    val handle = snap.getString("handle") ?: ""
                    emittedStages.add("$handle:${snap.metadata.hasPendingWrites()}")
                }
            }
        }

        try {
            directRef.set(
                mapOf(
                    "handle" to "ada",
                    "level" to 7L,
                    "score" to 98.5,
                    "active" to true,
                    "tags" to listOf("kotlin", "flow"),
                    "counters" to mapOf("wins" to 12L),
                    "primaryBadge" to mapOf("code" to "founder", "tier" to 3L)
                )
            )
            awaitMainLooperCondition("fs.wave5.smoke.flowEmitted", 10_000L) {
                emittedStages.contains("ada:true") && inSyncCounter.get() >= 1
            }

            val cachedProfileSnap = awaitFirebaseTask(
                directRef.get(Source.CACHE),
                "fs.wave5.smoke.getProfileCache",
                10_000L
            )
            val pojo = cachedProfileSnap.toObject<OracleProfilePojo>()
            assertNotNull(pojo)
            assertEquals("ada", pojo?.docId)
            assertEquals("ada", pojo?.handle)
            assertEquals(7L, pojo?.level)
            assertEquals(98.5, pojo?.score ?: 0.0, 0.0001)
            assertEquals(true, pojo?.active)
            assertEquals(listOf("kotlin", "flow"), pojo?.tags)
            assertEquals(12L, pojo?.counters?.get("wins"))
            assertEquals("founder", pojo?.primaryBadge?.code)
            assertEquals(3L, pojo?.primaryBadge?.tier)

            val deletedRef = db.document("pyric_oracle/smoke_w5/profiles/deleted_profile")
            deletedRef.set(mapOf("handle" to "ephemeral"))
            deletedRef.delete()
            awaitMainLooperCondition("fs.wave5.smoke.deletedCached", 10_000L) {
                val res = runCatching {
                    awaitFirebaseTask(deletedRef.get(Source.CACHE), "fs.wave5.smoke.pollDeleted", 5_000L)
                }.getOrNull()
                res != null && !res.exists()
            }
            val deletedSnap = awaitFirebaseTask(
                deletedRef.get(Source.CACHE),
                "fs.wave5.smoke.getDeletedCache",
                10_000L
            )
            assertFalse(deletedSnap.exists())
            assertNull(deletedSnap.toObject<OracleProfilePojo>())

            val queryCol = db.collection("pyric_oracle/smoke_w5/ranks")
            queryCol.document("r1").set(mapOf("tier" to "bronze", "score" to 10L))
            queryCol.document("r2").set(mapOf("tier" to "silver", "score" to 20L))
            queryCol.document("r3").set(mapOf("tier" to "gold", "score" to 30L))
            awaitMainLooperCondition("fs.wave5.smoke.ranksCached", 10_000L) {
                val s = awaitFirebaseTask(queryCol.get(Source.CACHE), "fs.wave5.smoke.pollRanks", 5_000L)
                s.size() == 3
            }

            val neSnap = awaitFirebaseTask(
                queryCol.whereNotEqualTo("tier", "silver").get(Source.CACHE),
                "fs.wave5.smoke.whereNotEqualTo",
                10_000L
            )
            assertEquals(listOf("r1", "r3"), neSnap.documents.map { it.id })

            val notInSnap = awaitFirebaseTask(
                queryCol.whereNotIn("score", listOf(10L, 30L)).get(Source.CACHE),
                "fs.wave5.smoke.whereNotIn",
                10_000L
            )
            assertEquals(listOf("r2"), notInSnap.documents.map { it.id })

            val queryFlowIds = CopyOnWriteArrayList<List<String>>()
            val queryJob = scope.launch {
                queryCol.whereGreaterThan("score", 10L)
                    .orderBy("score", Query.Direction.ASCENDING)
                    .snapshots(MetadataChanges.EXCLUDE)
                    .collect { qs ->
                        queryFlowIds.add(qs.documents.map { it.id })
                    }
            }
            try {
                awaitMainLooperCondition("fs.wave5.smoke.queryFlow", 10_000L) {
                    queryFlowIds.any { it == listOf("r2", "r3") }
                }
            } finally {
                queryJob.cancel()
            }
        } finally {
            flowJob.cancel()
            inSyncReg.remove()
        }
    } finally {
        scope.cancel()
        executor.shutdownNow()
        shutdownFirebaseFirestoreAndApp(namedDb, namedApp)
        if (defaultApp != null) {
            shutdownFirebaseFirestoreAndApp(defaultDb, defaultApp)
        } else if (defaultDb != null) {
            runCatching { awaitFirebaseTask(defaultDb.terminate(), "fs.wave5.defaultTerminate", 10_000L) }
        }
    }
}
