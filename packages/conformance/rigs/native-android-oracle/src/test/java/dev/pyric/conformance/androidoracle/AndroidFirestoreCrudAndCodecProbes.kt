package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.Blob
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldPath
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.GeoPoint
import com.google.firebase.firestore.PersistentCacheSettings
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Source
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal fun verifyLocalRobolectricFirestoreSmoke(context: Context) {
    val appName = "pyric-robolectric-firestore-smoke-${System.nanoTime()}"
    val options = FirebaseOptions.Builder()
        .setProjectId("demo-robolectric-oracle")
        .setApplicationId("1:123456789000:android:abcdef012345")
        .setApiKey("AIzaSyDemoRobolectricSmokeKey00000000000")
        .build()

    val app = FirebaseApp.initializeApp(context, options, appName)
    var firestore: FirebaseFirestore? = null
    try {
        val db = FirebaseFirestore.getInstance(app)
        firestore = db
        val settings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(PersistentCacheSettings.newBuilder().build())
            .build()
        db.firestoreSettings = settings

        awaitFirebaseTask(db.disableNetwork(), "firestore.smoke.disableNetwork", 10_000L)

        val col = db.collection("pyric_oracle/smoke_run/items")
        val autoDoc = col.document()
        assertEquals(20, autoDoc.id.length)

        val fixedTime = Timestamp(1_730_000_000L, 123_000_000)
        val fixedGeo = GeoPoint(37.7749, -122.4194)
        val fixedBlob = Blob.fromBytes(byteArrayOf(1, 2, 3, 255.toByte()))
        val linkedRef = col.document("linked")

        val docRef = col.document("alpha")
        // Offline writes update local SQLite persistence immediately while their server-ack Task stays pending.
        docRef.set(
            mapOf(
                "title" to "Alpha",
                "score" to 10L,
                "tags" to listOf("kotlin", "seed"),
                "obsolete" to "remove-me",
                "createdAt" to fixedTime,
                "coords" to fixedGeo,
                "payload" to fixedBlob,
                "link" to linkedRef,
                "meta" to mapOf("tier" to "silver", "keep" to true)
            )
        )
        docRef.set(
            mapOf("mergedFlag" to true, "meta" to mapOf("tier" to "gold")),
            SetOptions.merge()
        )
        docRef.update(
            mapOf(
                "score" to FieldValue.increment(5L),
                "tags" to FieldValue.arrayUnion("live"),
                "obsolete" to FieldValue.delete()
            )
        )

        val batch = db.batch()
        batch.set(col.document("beta"), mapOf("title" to "Beta", "score" to 30L))
        batch.commit()

        // Allow Firestore's AsyncQueue to apply staged mutations to SQLite local cache before reading Source.CACHE.
        var cachedSnap = awaitFirebaseTask(docRef.get(Source.CACHE), "firestore.smoke.getCacheInitial", 10_000L)
        val retryDeadline = System.nanoTime() + 5_000_000_000L
        while ((!cachedSnap.exists() || cachedSnap.getLong("score") != 15L) && System.nanoTime() < retryDeadline) {
            Thread.sleep(20)
            cachedSnap = awaitFirebaseTask(docRef.get(Source.CACHE), "firestore.smoke.getCachePoll", 10_000L)
        }

        assertTrue(cachedSnap.exists())
        assertTrue(cachedSnap.metadata.isFromCache)
        assertTrue(cachedSnap.metadata.hasPendingWrites())
        assertEquals("Alpha", cachedSnap.getString("title"))
        assertEquals(true, cachedSnap.getBoolean("mergedFlag"))
        assertEquals(15L, cachedSnap.getLong("score"))
        assertFalse(cachedSnap.contains("obsolete"))
        assertEquals(fixedTime, cachedSnap.getTimestamp("createdAt"))
        assertEquals(fixedGeo, cachedSnap.getGeoPoint("coords"))
        assertArrayEquals(fixedBlob.toBytes(), cachedSnap.getBlob("payload")?.toBytes())
        assertEquals(linkedRef.path, cachedSnap.getDocumentReference("link")?.path)
        @Suppress("UNCHECKED_CAST")
        val metaMap = cachedSnap.get("meta") as? Map<String, Any?>
        assertNotNull(metaMap)
        assertEquals("gold", metaMap?.get("tier"))
        assertEquals(true, metaMap?.get("keep"))

        val querySnap = awaitFirebaseTask(
            col.orderBy("score", Query.Direction.DESCENDING).limit(2).get(Source.CACHE),
            "firestore.smoke.queryCache",
            10_000L
        )
        assertEquals(listOf("beta", "alpha"), querySnap.documents.map { it.id })

        val serverWhileOfflineErr = runCatching {
            awaitFirebaseTask(docRef.get(Source.SERVER), "firestore.smoke.getServerOffline", 10_000L)
        }.exceptionOrNull()
        assertTrue(serverWhileOfflineErr is FirebaseFirestoreException)
        assertEquals(
            FirebaseFirestoreException.Code.UNAVAILABLE,
            (serverWhileOfflineErr as FirebaseFirestoreException).code
        )

        val clearActiveErr = runCatching {
            awaitFirebaseTask(db.clearPersistence(), "firestore.smoke.clearActive", 10_000L)
        }.exceptionOrNull()
        assertTrue(clearActiveErr is FirebaseFirestoreException)
        assertEquals(
            FirebaseFirestoreException.Code.FAILED_PRECONDITION,
            (clearActiveErr as FirebaseFirestoreException).code
        )

        awaitFirebaseTask(db.terminate(), "firestore.smoke.terminate", 10_000L)
        firestore = null
        awaitFirebaseTask(db.clearPersistence(), "firestore.smoke.clearAfterTerminate", 10_000L)
    } finally {
        shutdownFirebaseFirestoreAndApp(firestore, app)
    }

    ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).use { h2Listener ->
        h2Listener.soTimeout = 10_000
        val prefaceFuture = CompletableFuture<String>()
        val acceptThread = Thread {
            try {
                h2Listener.accept().use { client ->
                    client.soTimeout = 5_000
                    val buf = ByteArray(24)
                    var offset = 0
                    while (offset < buf.size) {
                        val read = client.getInputStream().read(buf, offset, buf.size - offset)
                        if (read <= 0) break
                        offset += read
                    }
                    prefaceFuture.complete(String(buf, 0, offset, StandardCharsets.US_ASCII))
                }
            } catch (t: Throwable) {
                prefaceFuture.completeExceptionally(t)
            }
        }
        acceptThread.isDaemon = true
        acceptThread.start()

        val h2AppName = "pyric-robolectric-firestore-h2-${System.nanoTime()}"
        val h2App = FirebaseApp.initializeApp(context, options, h2AppName)
        var h2Firestore: FirebaseFirestore? = null
        try {
            val h2Db = FirebaseFirestore.getInstance(h2App)
            h2Firestore = h2Db
            h2Db.firestoreSettings = FirebaseFirestoreSettings.Builder()
                .setHost("127.0.0.1:${h2Listener.localPort}")
                .setSslEnabled(false)
                .build()
            h2Db.collection("pyric_oracle/h2_smoke/items").document("ping").get(Source.SERVER)
            assertEquals(
                "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
                prefaceFuture.get(10, TimeUnit.SECONDS)
            )
        } finally {
            shutdownFirebaseFirestoreAndApp(h2Firestore, h2App)
            acceptThread.join(2_000)
        }
    }
}

internal fun runFirestoreCrudMergeSentinelsAndCodecsProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    FirebaseFirestore.setLoggingEnabled(true)
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val appName = "oracle-fs-crud-$runId"
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
            "fs.crud.signInWithCustomToken"
        )

        val db = FirebaseFirestore.getInstance(app)
        firestore = db
        val col = db.collection("pyric_oracle").document(runId).collection("crud_codecs")

        try {
            val mintedDoc = col.document()
            val mintedIdLength = mintedDoc.id.length

            val addedRef = awaitFirebaseTask(
                col.add(mapOf("kind" to "auto-added", "seq" to 1L)),
                "fs.crud.collectionAdd"
            )
            val addedSnap = awaitFirebaseTask(addedRef.get(Source.SERVER), "fs.crud.addedGetServer")

            val missingSnap = awaitFirebaseTask(
                col.document("missing_doc").get(Source.SERVER),
                "fs.crud.missingGetServer"
            )

            val fixedTimestamp = Timestamp(1_730_000_000L, 123_456_000)
            val fixedGeoPoint = GeoPoint(37.7749, -122.4194)
            val fixedBytes = byteArrayOf(0, 1, 127, 255.toByte())
            val fixedBlob = Blob.fromBytes(fixedBytes)
            val targetLinkRef: DocumentReference = col.document("linked_target")

            val profileRef = col.document("profile_doc")
            awaitFirebaseTask(
                profileRef.set(
                    mapOf(
                        "title" to "Initial",
                        "visits" to 10L,
                        "ratio" to 1.5,
                        "tags" to listOf("alpha", "beta", "drop"),
                        "obsolete" to "delete-me",
                        "fixedAt" to fixedTimestamp,
                        "location" to fixedGeoPoint,
                        "binary" to fixedBlob,
                        "linkedDoc" to targetLinkRef,
                        "nested" to mapOf(
                            "kept" to "yes",
                            "replaced" to "before",
                            "items" to listOf(1L, "two", true)
                        )
                    )
                ),
                "fs.crud.profileSet"
            )

            awaitFirebaseTask(
                profileRef.set(
                    mapOf(
                        "mergedFlag" to true,
                        "nested" to mapOf("replaced" to "after-merge")
                    ),
                    SetOptions.merge()
                ),
                "fs.crud.profileSetMerge"
            )

            awaitFirebaseTask(
                profileRef.set(
                    mapOf(
                        "title" to "MergedSelected",
                        "ignoredField" to "must-not-write",
                        "nested" to mapOf("kept" to "updated-selective", "ignoredNested" to true)
                    ),
                    SetOptions.mergeFields("title", "nested.kept")
                ),
                "fs.crud.profileSetMergeFields"
            )

            awaitFirebaseTask(
                profileRef.update(
                    FieldPath.of("visits"),
                    FieldValue.increment(5L),
                    FieldPath.of("ratio"),
                    FieldValue.increment(0.25),
                    FieldPath.of("tags"),
                    FieldValue.arrayUnion("gamma"),
                    FieldPath.of("obsolete"),
                    FieldValue.delete(),
                    FieldPath.of("stampedAt"),
                    FieldValue.serverTimestamp()
                ),
                "fs.crud.profileUpdateSentinels"
            )
            awaitFirebaseTask(
                profileRef.update("tags", FieldValue.arrayRemove("drop")),
                "fs.crud.profileArrayRemove"
            )

            val serverSnap = awaitFirebaseTask(
                profileRef.get(Source.SERVER),
                "fs.crud.profileGetServer"
            )
            val cacheSnap = awaitFirebaseTask(
                profileRef.get(Source.CACHE),
                "fs.crud.profileGetCache"
            )

            val readTs = serverSnap.getTimestamp("fixedAt")
            val stampedTs = serverSnap.getTimestamp("stampedAt")
            val readGeo = serverSnap.getGeoPoint("location")
            val readBlob = serverSnap.getBlob("binary")
            val readLink = serverSnap.getDocumentReference("linkedDoc")
            @Suppress("UNCHECKED_CAST")
            val readTags = (serverSnap.get("tags") as? List<Any?>).orEmpty()
            @Suppress("UNCHECKED_CAST")
            val readNested = serverSnap.get("nested") as? Map<String, Any?>

            awaitFirebaseTask(addedRef.delete(), "fs.crud.addedDelete")
            val afterDeleteSnap = awaitFirebaseTask(
                addedRef.get(Source.SERVER),
                "fs.crud.addedGetAfterDelete"
            )

            val tagsJson = JSONArray()
            for (tag in readTags) {
                tagsJson.put(tag)
            }

            return JSONObject()
                .put("autoDocumentIdLength", mintedIdLength)
                .put("collectionAddIdLength", addedRef.id.length)
                .put("collectionAddExistsBeforeDelete", addedSnap.exists())
                .put("collectionAddExistsAfterDelete", afterDeleteSnap.exists())
                .put("missingDocExists", missingSnap.exists())
                .put("missingDocDataIsNull", missingSnap.data == null)
                .put("serverReadIsFromCache", serverSnap.metadata.isFromCache)
                .put("serverReadHasPendingWrites", serverSnap.metadata.hasPendingWrites())
                .put("cacheReadIsFromCache", cacheSnap.metadata.isFromCache)
                .put("titleAfterMergeFields", serverSnap.getString("title"))
                .put("ignoredFieldPresent", serverSnap.contains("ignoredField"))
                .put("mergedFlag", serverSnap.getBoolean("mergedFlag") == true)
                .put("nestedKeptValue", readNested?.get("kept"))
                .put("nestedReplacedPreserved", readNested?.get("replaced"))
                .put("nestedIgnoredPresent", readNested?.containsKey("ignoredNested") == true)
                .put("incrementLongResult", serverSnap.getLong("visits"))
                .put("incrementDoubleResult", serverSnap.getDouble("ratio"))
                .put("tagsAfterUnionAndRemove", tagsJson)
                .put("deletedFieldPresent", serverSnap.contains("obsolete"))
                .put("serverTimestampResolved", stampedTs != null && stampedTs.seconds > 1_700_000_000L)
                .put("timestampSecondsPreserved", readTs?.seconds == 1_730_000_000L)
                .put("timestampNanosecondsPreserved", readTs?.nanoseconds == 123_456_000)
                .put("geoPointMatches", readGeo?.latitude == 37.7749 && readGeo.longitude == -122.4194)
                .put("blobBytesMatch", readBlob != null && readBlob.toBytes().contentEquals(fixedBytes))
                .put(
                    "documentReferenceRelativeSuffixMatches",
                    readLink != null && readLink.path.endsWith("/crud_codecs/linked_target")
                )
        } finally {
            auth.signOut()
        }
    } finally {
        shutdownFirebaseFirestoreAndApp(firestore, app)
    }
}
