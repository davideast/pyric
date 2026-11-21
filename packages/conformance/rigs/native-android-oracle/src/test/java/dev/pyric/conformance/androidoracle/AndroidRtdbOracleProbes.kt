package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.Logger
import com.google.firebase.database.ServerValue
import org.json.JSONArray
import org.json.JSONObject

internal fun runRtdbDedicatedCrudAndQueryProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val databaseUrl = config.getString("databaseUrl")
    val appName = "oracle-rtdb-$runId"
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .setDatabaseUrl(databaseUrl)
        .build()

    val app = FirebaseApp.initializeApp(context, options, appName)
    var db: FirebaseDatabase? = null
    try {
        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(config.getString("customToken")),
            "rtdb.auth.signInWithCustomToken"
        )

        val database = FirebaseDatabase.getInstance(app, databaseUrl)
        db = database
        runCatching { database.setLogLevel(Logger.Level.DEBUG) }
        database.goOnline()

        val baseRef = database.getReference("pyric_oracle/$runId/rtdb_kotlin")
        try {
            val itemRef = baseRef.child("counter_doc")
            awaitFirebaseTask(
                itemRef.setValue(mapOf("label" to "alpha", "count" to 10L)),
                "rtdb.itemRef.setValue"
            )
            awaitFirebaseTask(
                itemRef.updateChildren(
                    mapOf(
                        "count" to ServerValue.increment(5L),
                        "extra" to "kept"
                    )
                ),
                "rtdb.itemRef.updateChildren"
            )

            val snap = awaitFirebaseTask(itemRef.get(), "rtdb.itemRef.getAfterUpdate")
            val countVal = snap.child("count").value

            val catalogRef = baseRef.child("catalog")
            awaitFirebaseTask(
                catalogRef.setValue(
                    mapOf(
                        "c" to mapOf("score" to 30L),
                        "a" to mapOf("score" to 10L),
                        "b" to mapOf("score" to 20L)
                    )
                ),
                "rtdb.catalogRef.setValue"
            )

            val topTwoSnap = awaitFirebaseTask(
                catalogRef.orderByChild("score").limitToFirst(2).get(),
                "rtdb.catalogRef.orderByChildScoreLimitToFirst2"
            )
            val orderedKeys = JSONArray()
            for (child in topTwoSnap.children) {
                orderedKeys.put(child.key)
            }

            awaitFirebaseTask(itemRef.removeValue(), "rtdb.itemRef.removeValue")
            val afterRemoveSnap = awaitFirebaseTask(itemRef.get(), "rtdb.itemRef.getAfterRemove")

            return JSONObject()
                .put("existsAfterWrite", snap.exists())
                .put("keyMatches", snap.key == "counter_doc")
                .put("childrenCount", snap.childrenCount)
                .put("incrementedCount", (countVal as? Number)?.toLong())
                .put("integerValueClass", countVal?.javaClass?.name)
                .put("extraField", snap.child("extra").getValue(String::class.java))
                .put("orderedLimitToFirstKeys", orderedKeys)
                .put("existsAfterRemove", afterRemoveSnap.exists())
        } finally {
            runCatching {
                awaitFirebaseTask(baseRef.removeValue(), "rtdb.cleanup.removeValue", 10_000L)
            }
            auth.signOut()
        }
    } finally {
        shutdownFirebaseDatabaseAndApp(db, app)
    }
}
