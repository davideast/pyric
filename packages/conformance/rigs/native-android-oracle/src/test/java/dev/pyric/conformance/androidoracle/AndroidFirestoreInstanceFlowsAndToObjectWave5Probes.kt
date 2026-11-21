package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.firestore.MemoryCacheSettings
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.PersistentCacheSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.firestoreSettings
import com.google.firebase.firestore.memoryCacheSettings
import com.google.firebase.firestore.snapshots
import com.google.firebase.firestore.toObject
import com.google.firebase.firestore.toObjects
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

internal fun runFirestoreInstanceFlowsInSyncAndToObjectProbe(config: JSONObject): JSONObject {
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

    var createdDefaultApp: FirebaseApp? = null
    var defaultDb: FirebaseFirestore? = null
    val namedApp = FirebaseApp.initializeApp(context, options, "oracle-fs-w5-inst-$runId")
    var namedDb: FirebaseFirestore? = null
    val settingsApp = FirebaseApp.initializeApp(context, options, "oracle-fs-w5-settings-$runId")
    var settingsDb: FirebaseFirestore? = null
    val flowExecutor = Executors.newSingleThreadExecutor()
    val flowScope = CoroutineScope(SupervisorJob() + flowExecutor.asCoroutineDispatcher())

    try {
        // 1. Default & KTX FirebaseFirestore.getInstance() / Firebase.firestore (#1)
        val existingDefault = FirebaseApp.getApps(context)
            .firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
        val resolvedDefaultApp = existingDefault ?: FirebaseApp.initializeApp(context, options).also {
            createdDefaultApp = it
        }
        val dbDefault = FirebaseFirestore.getInstance()
        defaultDb = dbDefault
        val defaultSameAsKtx = (dbDefault === Firebase.firestore)
        val defaultAppName = resolvedDefaultApp.name

        val auth = FirebaseAuth.getInstance(namedApp)
        awaitFirebaseTask(auth.signInWithCustomToken(customToken), "fs.w5.inst.signIn")

        val db = FirebaseFirestore.getInstance(namedApp)
        namedDb = db
        val namedSameAsKtx = (db === Firebase.firestore(namedApp))
        val defaultAndNamedDistinct = (db !== dbDefault)

        // 2. FirebaseFirestore.firestoreSettings (#3)
        val cacheSizeBytes = 20L * 1024L * 1024L
        db.firestoreSettings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(
                PersistentCacheSettings.newBuilder().setSizeBytes(cacheSizeBytes).build()
            )
            .build()
        val defaultHost = db.firestoreSettings.host
        val defaultSslEnabled = db.firestoreSettings.isSslEnabled
        val persistentCacheConfigured = db.firestoreSettings.cacheSettings is PersistentCacheSettings
        val configuredCacheSizeBytes =
            (db.firestoreSettings.cacheSettings as? PersistentCacheSettings)?.sizeBytes

        val localSettingsDb = FirebaseFirestore.getInstance(settingsApp)
        settingsDb = localSettingsDb
        localSettingsDb.firestoreSettings = firestoreSettings {
            host = "127.0.0.1:8085"
            isSslEnabled = false
            setLocalCacheSettings(memoryCacheSettings {})
        }
        val customHost = localSettingsDb.firestoreSettings.host
        val customSslEnabled = localSettingsDb.firestoreSettings.isSslEnabled
        val memoryCacheConfigured = localSettingsDb.firestoreSettings.cacheSettings is MemoryCacheSettings
        awaitFirebaseTask(localSettingsDb.disableNetwork(), "fs.w5.inst.localSettingsDisableNet", 10_000L)
        val settingsReconfigureThrowsIllegalState = runCatching {
            localSettingsDb.firestoreSettings = firestoreSettings {
                host = "127.0.0.1:8086"
                isSslEnabled = false
            }
        }.exceptionOrNull() is IllegalStateException

        try {
            val readinessRef = db.document("pyric_oracle/$runId/instance_flows/readiness")
            awaitFirestoreWriteRulesReady(readinessRef, "fs.w5.inst")

            // 3. FirebaseFirestore.document(path) (#4)
            val directDocRef = db.document("pyric_oracle/$runId/instance_flows/direct_profile")
            val chainDocRef = db.collection("pyric_oracle")
                .document(runId)
                .collection("instance_flows")
                .document("direct_profile")
            val directDocEqualsCollectionChain = (directDocRef == chainDocRef)
            val directDocId = directDocRef.id
            val directDocParentId = directDocRef.parent.id
            val directDocOddSegmentsThrowsIllegalArgument = runCatching {
                db.document("pyric_oracle/$runId/odd_segment_collection")
            }.exceptionOrNull() is IllegalArgumentException

            // 4. DocumentReference.update(Map) + NOT_FOUND on missing doc (#17)
            awaitFirebaseTask(
                directDocRef.set(
                    mapOf(
                        "handle" to "grace",
                        "level" to 3L,
                        "score" to 42.5,
                        "active" to true,
                        "tags" to listOf("kotlin", "android"),
                        "counters" to mapOf("commits" to 10L, "reviews" to 4L),
                        "primaryBadge" to mapOf("code" to "pioneer", "tier" to 2L),
                        "obsolete" to "remove-via-map-update"
                    )
                ),
                "fs.w5.inst.seedDirectProfile"
            )
            awaitFirebaseTask(
                directDocRef.update(
                    mapOf<String, Any?>(
                        "level" to 5L,
                        "counters.reviews" to 9L,
                        "obsolete" to FieldValue.delete()
                    )
                ),
                "fs.w5.inst.updateMapDirectProfile"
            )

            val missingUpdateErr = runCatching {
                awaitFirebaseTask(
                    db.document("pyric_oracle/$runId/instance_flows/missing_for_update")
                        .update(mapOf<String, Any?>("level" to 1L)),
                    "fs.w5.inst.updateMissingDoc"
                )
            }.exceptionOrNull() as? FirebaseFirestoreException

            // 5. DocumentSnapshot.toObject<T>() & toObject(Class) & QuerySnapshot.toObjects<T>() (#42)
            val updatedSnap = awaitFirebaseTask(
                directDocRef.get(Source.SERVER),
                "fs.w5.inst.getUpdatedProfile"
            )
            val reifiedPojo = updatedSnap.toObject<OracleProfilePojo>()
            val classPojo = updatedSnap.toObject(OracleProfilePojo::class.java)
            val missingSnap = awaitFirebaseTask(
                db.document("pyric_oracle/$runId/instance_flows/missing_for_pojo").get(Source.SERVER),
                "fs.w5.inst.getMissingForPojo"
            )
            val missingPojoIsNull = (missingSnap.toObject<OracleProfilePojo>() == null)

            // 6. addSnapshotsInSyncListener (#13)
            val syncDocRef = db.document("pyric_oracle/$runId/instance_flows/sync_target")
            awaitFirebaseTask(syncDocRef.set(mapOf("rev" to 1L)), "fs.w5.inst.seedSyncDoc")
            val inSyncCount = AtomicInteger(0)
            val observedRevs = CopyOnWriteArrayList<Long>()
            var syncDocReg: ListenerRegistration? = null
            var inSyncReg: ListenerRegistration? = null
            var inSyncFiredOnAttach = false
            var inSyncFiredAfterWrite = false
            var inSyncQuietAfterRemove = false

            try {
                inSyncReg = db.addSnapshotsInSyncListener { inSyncCount.incrementAndGet() }
                syncDocReg = syncDocRef.addSnapshotListener(MetadataChanges.EXCLUDE) { snap, err ->
                    if (err == null && snap != null && snap.exists()) {
                        snap.getLong("rev")?.let { observedRevs.add(it) }
                    }
                }
                awaitMainLooperCondition("fs.w5.inst.initialSync", 15_000L) {
                    observedRevs.contains(1L) && inSyncCount.get() >= 1
                }
                inSyncFiredOnAttach = true
                val countBeforeRev2 = inSyncCount.get()
                awaitFirebaseTask(
                    syncDocRef.update(mapOf<String, Any?>("rev" to 2L)),
                    "fs.w5.inst.writeRev2"
                )
                awaitMainLooperCondition("fs.w5.inst.rev2Synced", 15_000L) {
                    observedRevs.contains(2L) && inSyncCount.get() > countBeforeRev2
                }
                inSyncFiredAfterWrite = true

                inSyncReg.remove()
                inSyncReg = null
                val countAtRemove = inSyncCount.get()
                awaitFirebaseTask(
                    syncDocRef.update(mapOf<String, Any?>("rev" to 3L)),
                    "fs.w5.inst.writeRev3AfterRemove"
                )
                awaitMainLooperCondition("fs.w5.inst.rev3Observed", 15_000L) {
                    observedRevs.contains(3L)
                }
                Thread.sleep(200)
                pumpMainLooper()
                inSyncQuietAfterRemove = (inSyncCount.get() == countAtRemove)
            } finally {
                inSyncReg?.remove()
                syncDocReg?.remove()
            }

            // 7. DocumentReference.snapshots(MetadataChanges) Flow (#20)
            val docFlowRef = db.document("pyric_oracle/$runId/instance_flows/doc_flow_target")
            awaitFirebaseTask(
                docFlowRef.set(mapOf("stage" to "alpha", "seq" to 1L)),
                "fs.w5.inst.seedDocFlow"
            )
            val docExcludeStages = CopyOnWriteArrayList<String>()
            val docIncludePendingFlags = CopyOnWriteArrayList<String>()
            val docExcludeJob = flowScope.launch {
                docFlowRef.snapshots(MetadataChanges.EXCLUDE).collect { snap ->
                    if (snap.exists()) {
                        val label = "${snap.getString("stage")}:${snap.getLong("seq")}"
                        if (docExcludeStages.lastOrNull() != label) {
                            docExcludeStages.add(label)
                        }
                    }
                }
            }
            val docIncludeJob = flowScope.launch {
                docFlowRef.snapshots(MetadataChanges.INCLUDE).collect { snap ->
                    if (snap.exists()) {
                        docIncludePendingFlags.add(
                            "${snap.getString("stage")}:pending=${snap.metadata.hasPendingWrites()}"
                        )
                    }
                }
            }
            var docFlowQuietAfterCancel = false
            try {
                awaitMainLooperCondition("fs.w5.inst.docFlowInitial", 15_000L) {
                    docExcludeStages.contains("alpha:1") &&
                        docIncludePendingFlags.contains("alpha:pending=false")
                }
                awaitFirebaseTask(
                    docFlowRef.update(mapOf<String, Any?>("stage" to "beta", "seq" to 2L)),
                    "fs.w5.inst.updateDocFlowBeta"
                )
                awaitMainLooperCondition("fs.w5.inst.docFlowBetaSynced", 15_000L) {
                    docExcludeStages.contains("beta:2") &&
                        docIncludePendingFlags.contains("beta:pending=false")
                }
                docExcludeJob.cancel()
                docIncludeJob.cancel()
                Thread.sleep(150)
                pumpMainLooper()
                val sizeAtCancel = docExcludeStages.size
                awaitFirebaseTask(
                    docFlowRef.update(mapOf<String, Any?>("stage" to "gamma", "seq" to 3L)),
                    "fs.w5.inst.updateDocFlowAfterCancel"
                )
                Thread.sleep(250)
                pumpMainLooper()
                docFlowQuietAfterCancel = (docExcludeStages.size == sizeAtCancel)
            } finally {
                docExcludeJob.cancel()
                docIncludeJob.cancel()
            }

            // 8. Query.snapshots(MetadataChanges) Flow + QuerySnapshot.toObjects<T>() (#36, #42)
            val queryFlowCol = db.collection("pyric_oracle/$runId/query_flows")
            awaitFirebaseTask(
                queryFlowCol.document("qf_1").set(
                    mapOf("handle" to "linus", "level" to 20L, "score" to 88.0, "active" to true)
                ),
                "fs.w5.inst.seedQueryFlow1"
            )
            val queryFlowEmissions = CopyOnWriteArrayList<List<String>>()
            val queryToObjectsHandles = CopyOnWriteArrayList<List<String>>()
            val queryFlowJob = flowScope.launch {
                queryFlowCol
                    .whereLessThan("level", 100L)
                    .orderBy("level", Query.Direction.ASCENDING)
                    .snapshots(MetadataChanges.EXCLUDE)
                    .collect { qs ->
                        val ids = qs.documents.map { it.id }
                        if (queryFlowEmissions.lastOrNull() != ids) {
                            queryFlowEmissions.add(ids)
                        }
                        val beans = qs.toObjects<OracleProfilePojo>()
                        queryToObjectsHandles.add(beans.map { "${it.docId}:${it.handle}" })
                    }
            }
            var queryFlowQuietAfterCancel = false
            try {
                awaitMainLooperCondition("fs.w5.inst.queryFlowInitial", 15_000L) {
                    queryFlowEmissions.any { it == listOf("qf_1") }
                }
                awaitFirebaseTask(
                    queryFlowCol.document("qf_2").set(
                        mapOf("handle" to "margaret", "level" to 10L, "score" to 95.0, "active" to true)
                    ),
                    "fs.w5.inst.seedQueryFlow2"
                )
                awaitMainLooperCondition("fs.w5.inst.queryFlowAdded2", 15_000L) {
                    queryFlowEmissions.any { it == listOf("qf_2", "qf_1") }
                }
                awaitFirebaseTask(
                    queryFlowCol.document("qf_1").update(mapOf<String, Any?>("level" to 200L)),
                    "fs.w5.inst.promoteQueryFlow1OutOfRange"
                )
                awaitMainLooperCondition("fs.w5.inst.queryFlowFilteredOut1", 15_000L) {
                    queryFlowEmissions.lastOrNull() == listOf("qf_2")
                }
                queryFlowJob.cancel()
                Thread.sleep(150)
                pumpMainLooper()
                val queryCountAtCancel = queryFlowEmissions.size
                awaitFirebaseTask(
                    queryFlowCol.document("qf_3").set(
                        mapOf("handle" to "barbara", "level" to 5L, "score" to 99.0, "active" to true)
                    ),
                    "fs.w5.inst.seedQueryFlowAfterCancel"
                )
                Thread.sleep(250)
                pumpMainLooper()
                queryFlowQuietAfterCancel = (queryFlowEmissions.size == queryCountAtCancel)
            } finally {
                queryFlowJob.cancel()
            }

            val querySnapshotsHistoryJson = JSONArray()
            for (snapshotIds in queryFlowEmissions) {
                val arr = JSONArray()
                for (id in snapshotIds) {
                    arr.put(id)
                }
                querySnapshotsHistoryJson.put(arr)
            }
            val docExcludeStagesJson = JSONArray()
            for (stage in docExcludeStages) {
                docExcludeStagesJson.put(stage)
            }
            val pojoTagsJson = JSONArray()
            for (tag in reifiedPojo?.tags.orEmpty()) {
                pojoTagsJson.put(tag)
            }
            val latestToObjectsJson = JSONArray()
            for (entry in queryToObjectsHandles.lastOrNull().orEmpty()) {
                latestToObjectsJson.put(entry)
            }

            return JSONObject()
                .put("defaultInstanceSameAsKtx", defaultSameAsKtx)
                .put("defaultInstanceAppName", defaultAppName)
                .put("namedInstanceSameAsKtx", namedSameAsKtx)
                .put("defaultAndNamedInstancesDistinct", defaultAndNamedDistinct)
                .put("settingsDefaultHost", defaultHost)
                .put("settingsDefaultSslEnabled", defaultSslEnabled)
                .put("settingsPersistentCacheConfigured", persistentCacheConfigured)
                .put("settingsPersistentCacheSizeBytes", configuredCacheSizeBytes)
                .put("settingsCustomHost", customHost)
                .put("settingsCustomSslEnabled", customSslEnabled)
                .put("settingsMemoryCacheConfigured", memoryCacheConfigured)
                .put("settingsReconfigureAfterStartThrowsIllegalState", settingsReconfigureThrowsIllegalState)
                .put("directDocEqualsCollectionChain", directDocEqualsCollectionChain)
                .put("directDocId", directDocId)
                .put("directDocParentId", directDocParentId)
                .put("directDocOddSegmentsThrowsIllegalArgument", directDocOddSegmentsThrowsIllegalArgument)
                .put("updateMapPreservedHandle", updatedSnap.getString("handle"))
                .put("updateMapUpdatedLevel", updatedSnap.getLong("level"))
                .put("updateMapNestedReviews", updatedSnap.getLong("counters.reviews"))
                .put("updateMapPreservedCommits", updatedSnap.getLong("counters.commits"))
                .put("updateMapDeletedFieldPresent", updatedSnap.contains("obsolete"))
                .put("updateMissingDocErrorCodeName", missingUpdateErr?.code?.name)
                .put("updateMissingDocErrorCodeValue", missingUpdateErr?.code?.value())
                .put("toObjectDocumentId", reifiedPojo?.docId)
                .put("toObjectHandle", reifiedPojo?.handle)
                .put("toObjectLevel", reifiedPojo?.level)
                .put("toObjectScore", reifiedPojo?.score)
                .put("toObjectActive", reifiedPojo?.active)
                .put("toObjectTags", pojoTagsJson)
                .put("toObjectNestedBadgeCode", reifiedPojo?.primaryBadge?.code)
                .put("toObjectNestedBadgeTier", reifiedPojo?.primaryBadge?.tier)
                .put("toObjectClassMatchesReified", classPojo?.docId == reifiedPojo?.docId && classPojo?.level == reifiedPojo?.level)
                .put("toObjectMissingDocReturnsNull", missingPojoIsNull)
                .put("inSyncFiredOnAttach", inSyncFiredOnAttach)
                .put("inSyncFiredAfterWrite", inSyncFiredAfterWrite)
                .put("inSyncQuietAfterRemove", inSyncQuietAfterRemove)
                .put("docSnapshotsExcludeStages", docExcludeStagesJson)
                .put(
                    "docSnapshotsIncludeObservedPendingAndSynced",
                    docIncludePendingFlags.contains("beta:pending=true") &&
                        docIncludePendingFlags.contains("beta:pending=false")
                )
                .put("docSnapshotsQuietAfterCancel", docFlowQuietAfterCancel)
                .put("querySnapshotsEmissionHistory", querySnapshotsHistoryJson)
                .put("querySnapshotsLatestToObjects", latestToObjectsJson)
                .put("querySnapshotsQuietAfterCancel", queryFlowQuietAfterCancel)
        } finally {
            auth.signOut()
        }
    } finally {
        flowScope.cancel()
        flowExecutor.shutdownNow()
        shutdownFirebaseFirestoreAndApp(settingsDb, settingsApp)
        shutdownFirebaseFirestoreAndApp(namedDb, namedApp)
        if (createdDefaultApp != null) {
            shutdownFirebaseFirestoreAndApp(defaultDb, createdDefaultApp)
        } else if (defaultDb != null) {
            runCatching { awaitFirebaseTask(defaultDb.terminate(), "fs.w5.inst.defaultTerminate", 10_000L) }
        }
    }
}
