package dev.pyric.crashlytics

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Firebase
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.crashlytics.CustomKeysAndValues
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.crashlytics.crashlytics
import com.google.firebase.crashlytics.recordException
import com.google.firebase.crashlytics.setCustomKeys
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import java.io.EOFException
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class FirebaseCrashlyticsTest {
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private val recordedOps = CopyOnWriteArrayList<Map<String, Any?>>()
    private val reportSeq = AtomicInteger(0)

    private class MockAppBucket(
        var collectionEnabled: Boolean = true,
        var userId: String? = null,
        val customKeys: MutableMap<String, Any?> = LinkedHashMap(),
        val logs: MutableList<Map<String, Any?>> = ArrayList(),
        val reports: MutableList<Map<String, Any?>> = ArrayList(),
        val unsentReports: MutableList<Map<String, Any?>> = ArrayList()
    )

    private val buckets = LinkedHashMap<String, MockAppBucket>()

    @BeforeEach
    fun setUp() {
        FirebaseCrashlytics.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
        recordedOps.clear()
        reportSeq.set(0)
        synchronized(buckets) { buckets.clear() }

        transport = InMemoryBridgeTransport()
        transport.onServerReceive { raw ->
            val msg = JsonCodec.decodeMap(raw)
            when (msg["type"]) {
                "attach" -> {
                    transport.sendToClient(
                        """{"type":"attach-ack","protocol":1,"peerConnected":true,"clientSessionId":"unit-crashlytics"}"""
                    )
                }
                "worker-op" -> handleWorkerOp(msg)
            }
        }
        bridgeClient = PyricBridgeClient(transport)
    }

    @AfterEach
    fun tearDown() {
        FirebaseCrashlytics.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    private fun bucketFor(op: Map<String, Any?>): MockAppBucket = synchronized(buckets) {
        val appId = (op["appId"] as? String) ?: "default"
        buckets.getOrPut(appId) { MockAppBucket() }
    }

    private fun handleWorkerOp(msg: Map<String, Any?>) {
        val id = msg["id"] as String
        @Suppress("UNCHECKED_CAST")
        val op = msg["op"] as Map<String, Any?>
        recordedOps.add(op)

        val method = op["method"] as String
        val value: Any? = synchronized(buckets) {
            val bucket = bucketFor(op)
            when (method) {
                "crashlytics.log" -> {
                    bucket.logs.add(
                        mapOf(
                            "message" to op["message"],
                            "timestampMs" to op["timestampMs"]
                        )
                    )
                    mapOf("logged" to true, "logCount" to bucket.logs.size)
                }
                "crashlytics.setUserId" -> {
                    bucket.userId = op["userId"] as? String
                    null
                }
                "crashlytics.setCustomKeys" -> {
                    @Suppress("UNCHECKED_CAST")
                    val incoming = op["keys"] as? Map<String, Any?> ?: emptyMap()
                    bucket.customKeys.putAll(incoming)
                    null
                }
                "crashlytics.setCollectionEnabled" -> {
                    val rawEnabled = op["enabled"] as? Boolean
                    bucket.collectionEnabled = rawEnabled ?: true
                    mapOf("enabled" to bucket.collectionEnabled)
                }
                "crashlytics.recordError" -> {
                    val reportId = "rep-${reportSeq.incrementAndGet()}"
                    val deferred = (op["deferred"] as? Boolean) == true || !bucket.collectionEnabled
                    val entry = LinkedHashMap<String, Any?>(op).apply {
                        put("reportId", reportId)
                    }
                    if (deferred) {
                        bucket.unsentReports.add(entry)
                        mapOf("reportId" to reportId, "queued" to true, "flushed" to false)
                    } else {
                        bucket.reports.add(entry)
                        mapOf("reportId" to reportId, "queued" to false, "flushed" to true)
                    }
                }
                "crashlytics.checkForUnsentReports" -> {
                    mapOf(
                        "hasUnsentReports" to bucket.unsentReports.isNotEmpty(),
                        "count" to bucket.unsentReports.size
                    )
                }
                "crashlytics.sendUnsentReports" -> {
                    val count = bucket.unsentReports.size
                    bucket.reports.addAll(bucket.unsentReports)
                    bucket.unsentReports.clear()
                    mapOf("sentCount" to count)
                }
                "crashlytics.deleteUnsentReports" -> {
                    val count = bucket.unsentReports.size
                    bucket.unsentReports.clear()
                    mapOf("deletedCount" to count)
                }
                "crashlytics.flush" -> {
                    mapOf("flushedCount" to bucket.reports.size)
                }
                "crashlytics.getState" -> {
                    mapOf(
                        "collectionEnabled" to bucket.collectionEnabled,
                        "userId" to bucket.userId,
                        "customKeys" to LinkedHashMap(bucket.customKeys),
                        "appVersion" to null,
                        "region" to null,
                        "didCrashOnPreviousExecution" to false,
                        "logs" to ArrayList(bucket.logs),
                        "reports" to ArrayList(bucket.reports),
                        "unsentReports" to ArrayList(bucket.unsentReports)
                    )
                }
                else -> null
            }
        }

        val reply = JsonCodec.encodeToString(
            mapOf("type" to "worker-res", "id" to id, "ok" to true, "value" to value)
        )
        transport.sendToClient(reply)
    }

    private fun newApp(name: String): FirebaseApp {
        return FirebaseApp.initializeApp(
            name,
            FirebaseOptions.Builder()
                .setProjectId("demo-crashlytics-unit")
                .setApiKey("demo-api-key")
                .setApplicationId("1:777777777777:android:crashunit")
                .build()
        )
    }

    @Test
    fun `singleton KTX JVM ABI overloads and per-app isolation match firebase-crashlytics`() {
        val ktxClass = Class.forName("com.google.firebase.crashlytics.FirebaseCrashlyticsKt")
        assertNotNull(ktxClass)

        // Verify both Java primitive boolean and boxed Boolean overloads exist in bytecode
        val primMethod = FirebaseCrashlytics::class.java.getMethod(
            "setCrashlyticsCollectionEnabled",
            Boolean::class.javaPrimitiveType
        )
        val boxedMethod = FirebaseCrashlytics::class.java.getMethod(
            "setCrashlyticsCollectionEnabled",
            java.lang.Boolean::class.java
        )
        assertNotNull(primMethod)
        assertNotNull(boxedMethod)

        val defaultApp = FirebaseApp.getInstance()
        defaultApp.getOrCreateBridgeClient(bridgeClient)
        val secondaryApp = newApp("secondary-crash-app")
        secondaryApp.getOrCreateBridgeClient(bridgeClient)

        assertSame(FirebaseCrashlytics.getInstance(), Firebase.crashlytics)
        assertSame(FirebaseCrashlytics.getInstance(secondaryApp), Firebase.crashlytics(secondaryApp))
        assertNotSame(Firebase.crashlytics, Firebase.crashlytics(secondaryApp))

        Firebase.crashlytics.setUserId("default-user")
        Firebase.crashlytics(secondaryApp).setUserId("secondary-user")
        Tasks.await(Firebase.crashlytics.flush(), 5, TimeUnit.SECONDS)
        Tasks.await(Firebase.crashlytics(secondaryApp).flush(), 5, TimeUnit.SECONDS)

        val userOps = recordedOps.filter { it["method"] == "crashlytics.setUserId" }
        val defaultOp = userOps.first { it["userId"] == "default-user" }
        val secondaryOp = userOps.first { it["userId"] == "secondary-user" }
        assertFalse(defaultOp.containsKey("appId"))
        assertEquals("secondary-crash-app", secondaryOp["appId"])
    }

    @Test
    fun `FIFO ordering custom keys KTX DSL breadcrumbs and cause chain serialization`() {
        val app = newApp("fifo-crash-app")
        val crashlytics = FirebaseCrashlytics.getInstance(app, bridgeClient)

        crashlytics.setUserId("u-42")
        crashlytics.setCustomKey("flag", true)
        crashlytics.setCustomKey("count", 7)
        crashlytics.setCustomKey("bigCount", 9_000_000_000L)
        crashlytics.setCustomKey("ratio", 1.5)
        crashlytics.setCustomKey("floatRatio", 2.25f)
        crashlytics.setCustomKey("tier", "gold")
        crashlytics.setCustomKeys {
            key("tier", "platinum")
            key("region", "us-central1")
        }

        crashlytics.log("step 1: open checkout")
        crashlytics.log("step 2: submit payment")

        val leaf = EOFException("premature end of stream")
        val middle = IOException("gateway read failed", leaf)
        val top = IllegalStateException("checkout aborted", middle)

        // Per-exception KTX keys override session keys for this report without mutating future reports
        crashlytics.recordException(top) {
            key("tier", "override-for-single-report")
            key("attempt", 3)
        }

        val secondEx = IllegalArgumentException("bad coupon")
        crashlytics.recordException(
            secondEx,
            CustomKeysAndValues.Builder().putString("coupon", "EXPIRED10").build()
        )

        Tasks.await(crashlytics.flush(), 5, TimeUnit.SECONDS)

        val methodsInOrder = recordedOps.map { it["method"] as String }
        assertEquals("crashlytics.setUserId", methodsInOrder.first())
        assertEquals("crashlytics.flush", methodsInOrder.last())

        val errorOps = recordedOps.filter { it["method"] == "crashlytics.recordError" }
        assertEquals(2, errorOps.size)

        val firstReport = errorOps[0]
        assertEquals("java.lang.IllegalStateException", firstReport["name"])
        assertEquals("checkout aborted", firstReport["message"])
        assertEquals("android", firstReport["sdkPlatform"])
        assertEquals(false, firstReport["fatal"])
        assertEquals(false, firstReport["deferred"])
        val stack = firstReport["stack"] as String
        assertTrue(stack.contains("IllegalStateException: checkout aborted"))
        assertTrue(stack.contains("Caused by: java.io.IOException: gateway read failed"))
        val cause = firstReport["cause"] as String
        assertEquals(
            "java.io.IOException: gateway read failed <- java.io.EOFException: premature end of stream",
            cause
        )

        @Suppress("UNCHECKED_CAST")
        val firstAttrs = firstReport["attributes"] as Map<String, Any?>
        assertEquals("override-for-single-report", firstAttrs["tier"])
        assertEquals(3, firstAttrs["attempt"])
        assertEquals("us-central1", firstAttrs["region"])
        assertEquals(true, firstAttrs["flag"])
        assertEquals(9_000_000_000L, firstAttrs["bigCount"])

        @Suppress("UNCHECKED_CAST")
        val crumbs = firstReport["breadcrumbs"] as List<Map<String, Any?>>
        assertEquals(2, crumbs.size)
        assertEquals("step 1: open checkout", crumbs[0]["message"])
        assertEquals("step 2: submit payment", crumbs[1]["message"])

        // Second report sees session tier == "platinum" (not mutated by first report's per-call override)
        @Suppress("UNCHECKED_CAST")
        val secondAttrs = errorOps[1]["attributes"] as Map<String, Any?>
        assertEquals("platinum", secondAttrs["tier"])
        assertEquals("EXPIRED10", secondAttrs["coupon"])
        assertNull(secondAttrs["attempt"])

        // Circular cause chains terminate cleanly without infinite recursion
        val cycleA = RuntimeException("cycle-a")
        val cycleB = RuntimeException("cycle-b", cycleA)
        cycleA.initCause(cycleB)
        val formattedCycle = FirebaseCrashlytics.formatCauseChain(cycleA.cause)
        assertNotNull(formattedCycle)
        assertTrue(formattedCycle!!.contains("CIRCULAR REFERENCE"))
    }

    @Test
    fun `disabled collection defers into unsent reports and supports check send delete and nullable reset`() {
        val app = newApp("unsent-crash-app")
        app.isDataCollectionDefaultEnabled = true
        val crashlytics = FirebaseCrashlytics.getInstance(app, bridgeClient)

        assertTrue(crashlytics.isCrashlyticsCollectionEnabled())
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 5, TimeUnit.SECONDS))

        // Disable collection -> recordException queues into unsentReports (deferred == true)
        crashlytics.setCrashlyticsCollectionEnabled(false)
        assertFalse(crashlytics.isCrashlyticsCollectionEnabled())

        crashlytics.recordException(RuntimeException("offline-unsent-1"))
        crashlytics.recordException(RuntimeException("offline-unsent-2"))
        assertTrue(Tasks.await(crashlytics.checkForUnsentReports(), 5, TimeUnit.SECONDS))

        val stateWhileDeferred = Tasks.await(crashlytics.getState(), 5, TimeUnit.SECONDS)
        @Suppress("UNCHECKED_CAST")
        assertEquals(2, (stateWhileDeferred["unsentReports"] as List<*>).size)
        @Suppress("UNCHECKED_CAST")
        assertEquals(0, (stateWhileDeferred["reports"] as List<*>).size)

        // sendUnsentReports flushes queued reports into sent reports
        crashlytics.sendUnsentReports()
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 5, TimeUnit.SECONDS))
        val stateAfterSend = Tasks.await(crashlytics.getState(), 5, TimeUnit.SECONDS)
        @Suppress("UNCHECKED_CAST")
        assertEquals(2, (stateAfterSend["reports"] as List<*>).size)

        // Queue another unsent report and discard via deleteUnsentReports
        crashlytics.recordException(RuntimeException("discard-me"))
        assertTrue(Tasks.await(crashlytics.checkForUnsentReports(), 5, TimeUnit.SECONDS))
        crashlytics.deleteUnsentReports()
        assertFalse(Tasks.await(crashlytics.checkForUnsentReports(), 5, TimeUnit.SECONDS))

        // Passing null to setCrashlyticsCollectionEnabled(Boolean?) falls back to FirebaseApp default
        val nullOverride: Boolean? = null
        crashlytics.setCrashlyticsCollectionEnabled(nullOverride)
        assertTrue(crashlytics.isCrashlyticsCollectionEnabled())
        Tasks.await(crashlytics.flush(), 5, TimeUnit.SECONDS)
        val lastSetEnabled = recordedOps.last { it["method"] == "crashlytics.setCollectionEnabled" }
        assertTrue(lastSetEnabled.containsKey("enabled"))
        assertNull(lastSetEnabled["enabled"])

        // didCrashOnPreviousExecution + simulatePreviousCrashForTest
        assertFalse(crashlytics.didCrashOnPreviousExecution())
        crashlytics.simulatePreviousCrashForTest(true)
        assertTrue(crashlytics.didCrashOnPreviousExecution())
    }
}
