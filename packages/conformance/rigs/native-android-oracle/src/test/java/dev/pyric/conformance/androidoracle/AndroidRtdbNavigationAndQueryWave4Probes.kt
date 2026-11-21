package dev.pyric.conformance.androidoracle

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.database.DataSnapshot
import com.google.firebase.database.DatabaseError
import com.google.firebase.database.DatabaseException
import com.google.firebase.database.FirebaseDatabase
import com.google.firebase.database.Logger
import com.google.firebase.database.ServerValue
import com.google.firebase.database.ValueEventListener
import com.google.firebase.database.database
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal fun runRtdbNavigationPushPrioritiesAndSnapshotsProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val databaseUrl = config.getString("databaseUrl").trimEnd('/')
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .setDatabaseUrl(databaseUrl)
        .build()

    val createdDefaultApp = FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME }
    val defaultApp = if (createdDefaultApp) {
        FirebaseApp.initializeApp(context, options)
    } else {
        FirebaseApp.getInstance()
    }
    var defaultDb: FirebaseDatabase? = null

    val app = FirebaseApp.initializeApp(context, options, "oracle-rtdb-nav-$runId")
    var db: FirebaseDatabase? = null
    try {
        if (createdDefaultApp) {
            val ddb = FirebaseDatabase.getInstance()
            defaultDb = ddb
            ddb.goOffline()
        }
        val defaultInstanceMatchesKtx = if (createdDefaultApp) {
            FirebaseDatabase.getInstance() === Firebase.database
        } else {
            FirebaseDatabase.getInstance(app, databaseUrl) === Firebase.database(app, databaseUrl)
        }
        val defaultRootMatchesUrl = if (createdDefaultApp) {
            FirebaseDatabase.getInstance().reference.toString().trimEnd('/') == databaseUrl
        } else {
            FirebaseDatabase.getInstance(app, databaseUrl).reference.toString().trimEnd('/') == databaseUrl
        }

        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(config.getString("customToken")),
            "rtdb.nav.signInWithCustomToken"
        )

        val database = FirebaseDatabase.getInstance(app, databaseUrl)
        db = database
        val namedDatabaseMatchesKtx = database === Firebase.database(app, databaseUrl)
        runCatching { database.setLogLevel(Logger.Level.DEBUG) }
        database.goOnline()

        val rootRef = database.reference
        val rootKeyIsNull = rootRef.key == null
        val rootParentIsNull = rootRef.parent == null
        val rootSelfEqualsRoot = rootRef.root == rootRef

        val baseRef = database.getReference("pyric_oracle/$runId/rtdb_kotlin")
        try {
            val nestedLeaf = baseRef.child("nav/section/leaf_node")
            val nestedKey = nestedLeaf.key
            val nestedParentKey = nestedLeaf.parent?.key
            val nestedGrandParentKey = nestedLeaf.parent?.parent?.key
            val nestedRootKeyIsNull = nestedLeaf.root.key == null
            val nestedRootMatchesDatabaseRoot = nestedLeaf.root == rootRef
            val normalizedRelativeSuffix = nestedLeaf.toString()
                .removePrefix(databaseUrl)
                .endsWith("/rtdb_kotlin/nav/section/leaf_node")

            val pushGroup = baseRef.child("pushed_items")
            val push1 = pushGroup.push()
            val push2 = pushGroup.push()
            val push3 = pushGroup.push()
            val k1 = requireNotNull(push1.key)
            val k2 = requireNotNull(push2.key)
            val k3 = requireNotNull(push3.key)
            val pushKeysMonotonic = k1 < k2 && k2 < k3 && k1 != k2 && k2 != k3

            awaitFirebaseTask(push1.setValue("first"), "rtdb.nav.push1")
            awaitFirebaseTask(push2.setValue("second"), "rtdb.nav.push2")
            awaitFirebaseTask(push3.setValue("third"), "rtdb.nav.push3")
            val pushOrderedSnap = awaitFirebaseTask(
                pushGroup.orderByKey().get(),
                "rtdb.nav.pushOrderByKey"
            )
            val pushOrderedValues = JSONArray()
            for (child in pushOrderedSnap.children) {
                pushOrderedValues.put(child.value)
            }

            val typesRef = baseRef.child("value_types")
            awaitFirebaseTask(
                typesRef.setValue(
                    mapOf(
                        "str" to "hello-rtdb",
                        "whole" to 42L,
                        "frac" to 3.5,
                        "flag" to true,
                        "list" to listOf("x", "y"),
                        "nested" to mapOf("inner" to 7L),
                        "stampedAt" to ServerValue.TIMESTAMP
                    )
                ),
                "rtdb.nav.typesSet"
            )
            val typesSnap = awaitFirebaseTask(typesRef.get(), "rtdb.nav.typesGet")
            val stampedVal = typesSnap.child("stampedAt").value
            val missingSnap = awaitFirebaseTask(
                baseRef.child("missing_leaf").get(),
                "rtdb.nav.missingGet"
            )

            val prioGroup = baseRef.child("priority_items")
            val pSecond = prioGroup.child("item_second")
            val pFirst = prioGroup.child("item_first")
            val pThird = prioGroup.child("item_third")

            awaitFirebaseTask(pSecond.setValue("second-by-set-priority"), "rtdb.nav.pSecondSet")
            awaitFirebaseTask(pSecond.setPriority(20.0), "rtdb.nav.pSecondSetPriority")
            awaitFirebaseTask(pFirst.setValue("first-with-priority", 5.0), "rtdb.nav.pFirstSetWithPrio")
            awaitFirebaseTask(pThird.setValue("third-string-priority", "zeta"), "rtdb.nav.pThirdSetWithPrio")

            val pSecondSnap = awaitFirebaseTask(pSecond.get(), "rtdb.nav.pSecondGet")
            val pFirstSnap = awaitFirebaseTask(pFirst.get(), "rtdb.nav.pFirstGet")
            val pThirdSnap = awaitFirebaseTask(pThird.get(), "rtdb.nav.pThirdGet")
            val prioGroupSnap = awaitFirebaseTask(prioGroup.get(), "rtdb.nav.prioGroupGet")
            val priorityOrderedValues = JSONArray()
            for (child in prioGroupSnap.children) {
                priorityOrderedValues.put(child.value)
            }

            val existedBeforeSetNull = pThirdSnap.exists()
            awaitFirebaseTask(pThird.setValue(null), "rtdb.nav.setNull")
            val afterSetNullSnap = awaitFirebaseTask(pThird.get(), "rtdb.nav.getAfterSetNull")

            return JSONObject()
                .put("defaultInstanceMatchesFirebaseKtx", defaultInstanceMatchesKtx)
                .put("defaultRootMatchesUrl", defaultRootMatchesUrl)
                .put("namedDatabaseMatchesFirebaseKtx", namedDatabaseMatchesKtx)
                .put("rootKeyIsNull", rootKeyIsNull)
                .put("rootParentIsNull", rootParentIsNull)
                .put("rootSelfEqualsRoot", rootSelfEqualsRoot)
                .put("nestedKey", nestedKey)
                .put("nestedParentKey", nestedParentKey)
                .put("nestedGrandParentKey", nestedGrandParentKey)
                .put("nestedRootKeyIsNull", nestedRootKeyIsNull)
                .put("nestedRootMatchesDatabaseRoot", nestedRootMatchesDatabaseRoot)
                .put("normalizedRelativePathSuffixMatches", normalizedRelativeSuffix)
                .put("pushKeyLength", k1.length)
                .put("pushKeysLexicographicallyMonotonic", pushKeysMonotonic)
                .put("pushOrderedValues", pushOrderedValues)
                .put("stringValueClass", typesSnap.child("str").value?.javaClass?.name)
                .put("integralValueClass", typesSnap.child("whole").value?.javaClass?.name)
                .put("integralValueEquals42", (typesSnap.child("whole").value as? Number)?.toLong() == 42L)
                .put("floatingValueClass", typesSnap.child("frac").value?.javaClass?.name)
                .put("booleanValueClass", typesSnap.child("flag").value?.javaClass?.name)
                .put("listValueClass", typesSnap.child("list").value?.javaClass?.name)
                .put("mapValueClass", typesSnap.child("nested").value?.javaClass?.name)
                .put("hasChildNested", typesSnap.hasChild("nested"))
                .put("hasChildMissing", typesSnap.hasChild("nonexistent"))
                .put("hasChildrenTrue", typesSnap.hasChildren())
                .put("missingSnapshotExists", missingSnap.exists())
                .put("missingSnapshotValueIsNull", missingSnap.value == null)
                .put("missingSnapshotHasChildren", missingSnap.hasChildren())
                .put("serverTimestampValueClass", stampedVal?.javaClass?.name)
                .put("serverTimestampEpochPlausible", (stampedVal as? Long ?: 0L) > 1_700_000_000_000L)
                .put("setPriorityPreservedValue", pSecondSnap.value)
                .put("setPriorityNumericValue", pSecondSnap.priority)
                .put("setPriorityNumericClass", pSecondSnap.priority?.javaClass?.name)
                .put("setValueWithNumericPriority", pFirstSnap.priority)
                .put("setValueWithStringPriority", pThirdSnap.priority)
                .put("setValueWithStringPriorityClass", pThirdSnap.priority?.javaClass?.name)
                .put("defaultPriorityOrderedValues", priorityOrderedValues)
                .put("existedBeforeSetNull", existedBeforeSetNull)
                .put("existsAfterSetNull", afterSetNullSnap.exists())
                .put("valueNullAfterSetNull", afterSetNullSnap.value == null)
                .put("priorityNullAfterSetNull", afterSetNullSnap.priority == null)
        } finally {
            runCatching {
                awaitFirebaseTask(baseRef.removeValue(), "rtdb.nav.cleanup", 10_000L)
            }
            auth.signOut()
        }
    } finally {
        shutdownFirebaseDatabaseAndApp(db, app)
        if (createdDefaultApp) {
            shutdownFirebaseDatabaseAndApp(defaultDb, defaultApp)
        }
    }
}

internal fun runRtdbQueriesRangesLimitsAndPermissionDeniedProbe(config: JSONObject): JSONObject {
    RobolectricTlsSupport.install()
    val context = ApplicationProvider.getApplicationContext<Context>()
    val runId = config.getString("runId")
    val databaseUrl = config.getString("databaseUrl")
    val options = FirebaseOptions.Builder()
        .setProjectId(config.getString("projectId"))
        .setApplicationId(config.getString("applicationId"))
        .setApiKey(config.getString("apiKey"))
        .setDatabaseUrl(databaseUrl)
        .build()

    val app = FirebaseApp.initializeApp(context, options, "oracle-rtdb-queries-$runId")
    var db: FirebaseDatabase? = null
    try {
        val auth = FirebaseAuth.getInstance(app)
        awaitFirebaseTask(
            auth.signInWithCustomToken(config.getString("customToken")),
            "rtdb.queries.signInWithCustomToken"
        )

        val database = FirebaseDatabase.getInstance(app, databaseUrl)
        db = database
        runCatching { database.setLogLevel(Logger.Level.DEBUG) }
        database.goOnline()

        val baseRef = database.getReference("pyric_oracle/$runId/rtdb_kotlin")
        try {
            val scoresRef = baseRef.child("scores")
            awaitFirebaseTask(
                scoresRef.setValue(
                    mapOf(
                        "c" to 40L,
                        "a" to 30L,
                        "e" to 20L,
                        "b" to 10L,
                        "d" to 20L
                    )
                ),
                "rtdb.queries.seedScores"
            )

            val playersRef = baseRef.child("players")
            awaitFirebaseTask(
                playersRef.setValue(
                    mapOf(
                        "p1" to mapOf("tier" to "gold", "score" to 10L),
                        "p2" to mapOf("tier" to "silver", "score" to 20L),
                        "p3" to mapOf("tier" to "gold", "score" to 30L),
                        "p4" to mapOf("tier" to "bronze", "score" to 40L)
                    )
                ),
                "rtdb.queries.seedPlayers"
            )

            val byKeyAll = childKeysJson(
                awaitFirebaseTask(scoresRef.orderByKey().get(), "rtdb.queries.byKeyAll")
            )
            val byKeyRange = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByKey().startAt("b").endAt("d").get(),
                    "rtdb.queries.byKeyRange"
                )
            )
            val byKeyFirst2 = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByKey().limitToFirst(2).get(),
                    "rtdb.queries.byKeyFirst2"
                )
            )
            val byKeyLast2 = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByKey().limitToLast(2).get(),
                    "rtdb.queries.byKeyLast2"
                )
            )

            val byValueAll = childKeysJson(
                awaitFirebaseTask(scoresRef.orderByValue().get(), "rtdb.queries.byValueAll")
            )
            val byValueEqual20 = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByValue().equalTo(20.0).get(),
                    "rtdb.queries.byValueEqual20"
                )
            )
            val byValueRange = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByValue().startAt(15.0).endAt(35.0).get(),
                    "rtdb.queries.byValueRange"
                )
            )
            val byValueLast2 = childKeysJson(
                awaitFirebaseTask(
                    scoresRef.orderByValue().limitToLast(2).get(),
                    "rtdb.queries.byValueLast2"
                )
            )

            val byChildTierGold = childKeysJson(
                awaitFirebaseTask(
                    playersRef.orderByChild("tier").equalTo("gold").get(),
                    "rtdb.queries.byChildTierGold"
                )
            )
            val byChildTierGoldKeyP3 = childKeysJson(
                awaitFirebaseTask(
                    playersRef.orderByChild("tier").equalTo("gold", "p3").get(),
                    "rtdb.queries.byChildTierGoldKeyP3"
                )
            )
            val byChildScoreRange = childKeysJson(
                awaitFirebaseTask(
                    playersRef.orderByChild("score").startAt(20.0).endAt(30.0).get(),
                    "rtdb.queries.byChildScoreRange"
                )
            )
            val byChildScoreLast2 = childKeysJson(
                awaitFirebaseTask(
                    playersRef.orderByChild("score").limitToLast(2).get(),
                    "rtdb.queries.byChildScoreLast2"
                )
            )

            val deniedRef = database.getReference("pyric_oracle/$runId/denied_zone/secret")
            val readDeniedCode = AtomicReference<Int?>(null)
            val readUnexpectedSuccess = AtomicBoolean(false)
            deniedRef.addListenerForSingleValueEvent(
                object : ValueEventListener {
                    override fun onDataChange(snapshot: DataSnapshot) {
                        readUnexpectedSuccess.set(true)
                    }

                    override fun onCancelled(error: DatabaseError) {
                        readDeniedCode.set(error.code)
                    }
                }
            )
            awaitMainLooperCondition("rtdb.queries.deniedRead") {
                readDeniedCode.get() != null || readUnexpectedSuccess.get()
            }

            val writeDeniedErr = runCatching {
                awaitFirebaseTask(deniedRef.setValue("forbidden"), "rtdb.queries.deniedWrite")
            }.exceptionOrNull()

            return JSONObject()
                .put("orderByKeyAll", byKeyAll)
                .put("orderByKeyRangeBToD", byKeyRange)
                .put("orderByKeyLimitToFirst2", byKeyFirst2)
                .put("orderByKeyLimitToLast2", byKeyLast2)
                .put("orderByValueAll", byValueAll)
                .put("orderByValueEqualTo20", byValueEqual20)
                .put("orderByValueRange15To35", byValueRange)
                .put("orderByValueLimitToLast2", byValueLast2)
                .put("orderByChildEqualToGold", byChildTierGold)
                .put("orderByChildEqualToGoldWithKeyP3", byChildTierGoldKeyP3)
                .put("orderByChildScoreRange20To30", byChildScoreRange)
                .put("orderByChildScoreLimitToLast2", byChildScoreLast2)
                .put(
                    "deniedReadCancelledWithPermissionDenied",
                    readDeniedCode.get() == DatabaseError.PERMISSION_DENIED
                )
                .put("deniedReadErrorCode", readDeniedCode.get())
                .put("deniedWriteThrewDatabaseException", writeDeniedErr is DatabaseException)
                .put(
                    "deniedWriteMessageMentionsPermissionDenied",
                    writeDeniedErr?.message?.contains("Permission denied", ignoreCase = true) == true
                )
        } finally {
            runCatching {
                awaitFirebaseTask(baseRef.removeValue(), "rtdb.queries.cleanup", 10_000L)
            }
            auth.signOut()
        }
    } finally {
        shutdownFirebaseDatabaseAndApp(db, app)
    }
}

private fun childKeysJson(snapshot: DataSnapshot): JSONArray {
    val arr = JSONArray()
    for (child in snapshot.children) {
        arr.put(child.key)
    }
    return arr
}
