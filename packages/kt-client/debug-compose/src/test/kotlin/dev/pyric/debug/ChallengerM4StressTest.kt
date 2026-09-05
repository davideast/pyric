package dev.pyric.debug

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import dev.pyric.debug.model.FieldDiffKind
import dev.pyric.debug.model.RuleCitation
import dev.pyric.debug.model.RulesDenialContext
import dev.pyric.debug.model.SandboxUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChallengerM4StressTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)
    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()

        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            if (msg["type"] == "attach") {
                transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
            }
        }

        val options = FirebaseOptions.Builder()
            .setApiKey("test-api-key")
            .setApplicationId("test-app-id")
            .setProjectId("test-project-id")
            .build()
        app = FirebaseApp.initializeApp("test-m4-stress-app", options)
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun testDenialContextAdversarialEdgeCases() {
        val adversarialPayload = mapOf<String, Any?>(
            "rule" to mapOf(
                "file" to "nested/path/to/firestore.rules",
                "line" to 999,
                "column" to 42,
                "expression" to "request.auth.token.role in ['admin', 'manager']"
            ),
            "auth" to mapOf(
                "uid" to "adversary-uid",
                "token" to mapOf(
                    "role" to "intern",
                    "admin" to false,
                    "firebase" to mapOf("tenant" to "multi-tenant-prod")
                )
            ),
            "reasons" to listOf(
                "false for 'get' @ L999",
                12345,
                true,
                null
            ),
            "failedFields" to listOf("ssn", 404, null, "secretSalary"),
            "request" to mapOf(
                "method" to "GET",
                "path" to "/databases/(default)/documents/employees/emp-1"
            ),
            "resource" to mapOf(
                "exists" to true,
                "data" to mapOf("salary" to 100000, "role" to "engineer")
            ),
            "query" to mapOf(
                "where" to listOf(
                    mapOf("field" to "department", "op" to "==", "value" to "security"),
                    mapOf("field" to "active", "op" to "==", "value" to true)
                ),
                "limit" to 100L,
                "orderBy" to "joinedAt"
            )
        )

        val context = RulesDenialContext.fromMap(adversarialPayload)

        assertNotNull(context.rule)
        assertEquals("nested/path/to/firestore.rules", context.rule?.file)
        assertEquals(999, context.rule?.line)
        assertEquals(42, context.rule?.column)
        assertEquals("nested/path/to/firestore.rules:999:42", context.rule?.formattedCitation)
        assertEquals("request.auth.token.role in ['admin', 'manager']", context.rule?.expression)

        assertNotNull(context.auth)
        assertEquals("adversary-uid", context.auth?.uid)
        assertEquals("multi-tenant-prod", context.auth?.tenant)
        assertEquals("intern", context.auth?.role)

        assertEquals(3, context.reasons.size)
        assertEquals("false for 'get' @ L999", context.reasons[0])
        assertEquals("12345", context.reasons[1])
        assertEquals("true", context.reasons[2])

        assertEquals(listOf("ssn", "404", "secretSalary"), context.failedFields)
        assertEquals("get", context.request?.method)

        assertNotNull(context.query)
        assertEquals(2, context.query?.where?.size)
        assertEquals(100L, context.query?.limit)
        assertEquals("joinedAt", context.query?.orderBy)
    }

    @Test
    fun testLargeDataDiffComputation() {
        val oldMap = mutableMapOf<String, Any?>()
        val newMap = mutableMapOf<String, Any?>()

        for (i in 0 until 50) {
            oldMap["common_$i"] = "val_$i"
            newMap["common_$i"] = "val_$i"
        }
        for (i in 0 until 20) {
            oldMap["mod_$i"] = "old_$i"
            newMap["mod_$i"] = "new_$i"
        }
        for (i in 0 until 15) {
            newMap["added_$i"] = "added_val_$i"
        }
        for (i in 0 until 10) {
            oldMap["removed_$i"] = "removed_val_$i"
        }

        val payload = mapOf(
            "request" to mapOf("resourceData" to newMap),
            "resource" to mapOf("data" to oldMap)
        )

        val context = RulesDenialContext.fromMap(payload)
        val diffs = context.computeDataDiff()

        assertEquals(45, diffs.size)
        assertEquals(15, diffs.count { it.kind == FieldDiffKind.ADDED })
        assertEquals(20, diffs.count { it.kind == FieldDiffKind.MODIFIED })
        assertEquals(10, diffs.count { it.kind == FieldDiffKind.REMOVED })
    }

    @Test
    fun testControllerRapidLensSwitchingAndRemoteSync() = runTest(testDispatcher) {
        val controller = PyricDebugController(auth, firestore, bridgeClient, scope = testScope)
        advanceUntilIdle()

        assertEquals(AuthLens.Anon, controller.activeLens.value)
        assertFalse(controller.isAdminBypassActive.value)

        val testUser = SandboxUser(
            uid = "pilot-user-1",
            email = "pilot@test.com",
            displayName = "Pilot User",
            customClaims = mapOf("tenant" to "tenant-sky", "role" to "pilot", "rank" to "captain")
        )
        controller.impersonateUser(testUser)
        advanceUntilIdle()

        val active = controller.activeLens.value
        assertTrue(active is AuthLens.AsUser)
        val userLens = active as AuthLens.AsUser
        assertEquals("pilot-user-1", userLens.uid)
        assertEquals("tenant-sky", userLens.tenant)
        assertFalse(controller.isAdminBypassActive.value)

        controller.toggleAdminBypass(true)
        advanceUntilIdle()
        assertTrue(controller.isAdminBypassActive.value)
        assertEquals(AuthLens.Admin, controller.activeLens.value)

        controller.toggleAdminBypass(false)
        advanceUntilIdle()
        assertFalse(controller.isAdminBypassActive.value)

        // Remote push
        val remoteMsg = mapOf(
            "type" to "worker-event",
            "event" to "remote-lens",
            "payload" to mapOf(
                "lens" to mapOf(
                    "mode" to "as",
                    "uid" to "remote-user-99",
                    "tenant" to "remote-tenant-x"
                )
            )
        )
        transport.sendToClient(JsonCodec.encodeToString(remoteMsg))
        Thread.sleep(100)
        advanceUntilIdle()

        val pushedLens = controller.activeLens.value
        assertTrue(pushedLens is AuthLens.AsUser)
        assertEquals("remote-user-99", (pushedLens as AuthLens.AsUser).uid)
        assertEquals("remote-tenant-x", pushedLens.tenant)
    }

    @Test
    fun testRuleCitationStringFallbackFormats() {
        val c1 = RuleCitation.parse("rules/security.rules:100:25")
        assertEquals("rules/security.rules", c1?.file)
        assertEquals(100, c1?.line)
        assertEquals(25, c1?.column)
        assertEquals("rules/security.rules:100:25", c1?.formattedCitation)

        val c2 = RuleCitation.parse("rules/security.rules:55")
        assertEquals("rules/security.rules", c2?.file)
        assertEquals(55, c2?.line)
        assertNull(c2?.column)
        assertEquals("rules/security.rules:55", c2?.formattedCitation)

        val c3 = RuleCitation.parse("rules/security.rules")
        assertEquals("rules/security.rules", c3?.file)
        assertNull(c3?.line)
        assertNull(c3?.column)
        assertEquals("rules/security.rules", c3?.formattedCitation)

        val c4 = RuleCitation.parse(mapOf("file" to "firestore.rules", "line" to 12))
        assertEquals("firestore.rules:12", c4?.formattedCitation)
    }
}
