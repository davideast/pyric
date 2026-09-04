package dev.pyric.debug

import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import dev.pyric.auth.AuthLens
import dev.pyric.bridge.InMemoryBridgeTransport
import dev.pyric.bridge.PyricBridgeClient
import dev.pyric.codecs.JsonCodec
import dev.pyric.debug.model.SandboxUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
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
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PyricDebugControllerTest {

    private val testDispatcher = StandardTestDispatcher()
    private val testScope = TestScope(testDispatcher)

    private lateinit var transport: InMemoryBridgeTransport
    private lateinit var bridgeClient: PyricBridgeClient
    private lateinit var app: FirebaseApp
    private lateinit var auth: FirebaseAuth
    private lateinit var firestore: FirebaseFirestore
    private lateinit var controller: PyricDebugController

    private val sandboxUsersFixture = listOf(
        mapOf(
            "uid" to "alice-1",
            "email" to "alice@example.com",
            "displayName" to "Alice Admin",
            "customClaims" to mapOf("role" to "admin", "tenant" to "corp"),
            "isAnonymous" to false
        ),
        mapOf(
            "uid" to "bob-2",
            "email" to "bob@example.com",
            "displayName" to "Bob Editor",
            "customClaims" to mapOf("role" to "editor"),
            "isAnonymous" to false
        ),
        mapOf(
            "uid" to "anon-3",
            "email" to null,
            "displayName" to null,
            "customClaims" to emptyMap<String, Any?>(),
            "isAnonymous" to true
        )
    )

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()

        transport = InMemoryBridgeTransport()
        bridgeClient = PyricBridgeClient(transport)

        transport.onServerReceive { json ->
            val msg = JsonCodec.decodeMap(json)
            when (msg["type"] as? String) {
                "attach" -> {
                    transport.sendToClient("""{"type":"attach-ack","protocol":1,"peerConnected":true}""")
                }
                "worker-op" -> {
                    val id = msg["id"] as String
                    @Suppress("UNCHECKED_CAST")
                    val op = msg["op"] as Map<String, Any?>
                    val method = op["method"] as String

                    when (method) {
                        "auth.listUsers" -> {
                            val res = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to sandboxUsersFixture
                            )
                            transport.sendToClient(JsonCodec.encodeToString(res))
                        }
                        else -> {
                            val res = mapOf(
                                "type" to "worker-res",
                                "id" to id,
                                "ok" to true,
                                "value" to emptyMap<String, Any?>()
                            )
                            transport.sendToClient(JsonCodec.encodeToString(res))
                        }
                    }
                }
                "worker-sub" -> {
                    val subId = msg["subId"] as String
                    val res = mapOf(
                        "type" to "worker-snap",
                        "subId" to subId,
                        "value" to null
                    )
                    transport.sendToClient(JsonCodec.encodeToString(res))
                }
            }
        }

        val options = FirebaseOptions.Builder()
            .setApiKey("test-api-key")
            .setApplicationId("test-app-id")
            .setProjectId("test-project-id")
            .build()
        app = FirebaseApp.initializeApp("test-debug-app", options)
        auth = FirebaseAuth.getInstance(app, bridgeClient)
        firestore = FirebaseFirestore(bridgeClient, app, "(default)", credentialsProvider = auth)
        controller = PyricDebugController(auth, firestore, bridgeClient, scope = testScope)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
        FirebaseAuth.clearInstancesForTest()
        FirebaseFirestore.clearInstancesForTest()
        FirebaseApp.clearInstancesForTest()
    }

    @Test
    fun testInitialState() = runTest(testDispatcher) {
        advanceUntilIdle()
        assertEquals(AuthLens.Anon, controller.activeLens.value)
        assertFalse(controller.isAdminBypassActive.value)
        assertEquals(0, controller.unviewedDenialsCount.value)
        assertEquals(DebugTab.IDENTITY, controller.selectedTab.value)
    }

    @Test
    fun testRefreshUsersAndSearch() = runTest(testDispatcher) {
        controller.refreshUsers()
        advanceUntilIdle()

        val users = controller.users.value
        assertEquals(3, users.size)
        assertEquals("alice-1", users[0].uid)
        assertEquals("Alice Admin", users[0].displayName)
        assertEquals("admin", users[0].role)
        assertEquals("corp", users[0].tenantId)

        // Search query filter
        controller.setUserSearchQuery("bob")
        advanceUntilIdle()
        val filtered = controller.filteredUsers.first()
        assertEquals(1, filtered.size)
        assertEquals("bob-2", filtered[0].uid)

        // Filter by role
        controller.setUserSearchQuery("admin")
        advanceUntilIdle()
        val adminFiltered = controller.filteredUsers.first()
        assertEquals(1, adminFiltered.size)
        assertEquals("alice-1", adminFiltered[0].uid)

        // Clear filter
        controller.setUserSearchQuery("")
        advanceUntilIdle()
        assertEquals(3, controller.filteredUsers.first().size)
    }

    @Test
    fun testImpersonationAndAdminBypass() = runTest(testDispatcher) {
        controller.refreshUsers()
        advanceUntilIdle()

        val alice = controller.users.value[0]
        controller.impersonateUser(alice)
        advanceUntilIdle()

        val active = controller.activeLens.value
        assertTrue(active is AuthLens.AsUser)
        val userLens = active as AuthLens.AsUser
        assertEquals("alice-1", userLens.uid)
        assertEquals("corp", userLens.tenant)
        assertFalse(controller.isAdminBypassActive.value)

        // Toggle Admin Bypass ON
        controller.toggleAdminBypass(true)
        advanceUntilIdle()
        assertEquals(AuthLens.Admin, controller.activeLens.value)
        assertTrue(controller.isAdminBypassActive.value)

        // Toggle Admin Bypass OFF -> returns to app session (anon)
        controller.toggleAdminBypass(false)
        advanceUntilIdle()
        assertEquals(AuthLens.Anon, controller.activeLens.value)
        assertFalse(controller.isAdminBypassActive.value)

        // Impersonate anonymous
        controller.impersonateAnonymous()
        advanceUntilIdle()
        assertEquals(AuthLens.Anon, controller.activeLens.value)
    }

    @Test
    fun testRemoteLensEventDispatcher() = runTest(testDispatcher) {
        advanceUntilIdle()

        val remoteLensMsg = mapOf(
            "type" to "worker-event",
            "event" to "remote-lens",
            "payload" to mapOf(
                "lens" to mapOf(
                    "mode" to "as",
                    "uid" to "remote-user-42",
                    "token" to mapOf("role" to "superadmin"),
                    "tenant" to "remote-tenant"
                )
            )
        )
        transport.sendToClient(JsonCodec.encodeToString(remoteLensMsg))
        Thread.sleep(150)
        advanceUntilIdle()

        val lens = controller.activeLens.value
        assertTrue(lens is AuthLens.AsUser)
        val userLens = lens as AuthLens.AsUser
        assertEquals("remote-user-42", userLens.uid)
        assertEquals("remote-tenant", userLens.tenant)
        assertEquals("superadmin", userLens.token?.get("role"))
    }

    @Test
    fun testDenialInterceptionAndMarkViewed() = runTest(testDispatcher) {
        advanceUntilIdle()

        val denialPayload = mapOf(
            "rule" to mapOf(
                "file" to "firestore.rules",
                "line" to 22,
                "col" to 9,
                "citation" to "firestore.rules:22:9",
                "expression" to "request.auth.token.role == 'admin'"
            ),
            "auth" to mapOf("uid" to "guest"),
            "reasons" to listOf("Evaluated false"),
            "request" to mapOf("method" to "delete", "path" to "orders/order-1")
        )

        val exception = FirebaseFirestoreException(
            "PERMISSION_DENIED",
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
            denialContext = denialPayload
        )

        // Notify via firestore
        firestore.notifyRulesDenial(exception)
        advanceUntilIdle()

        assertEquals(1, controller.denials.value.size)
        assertEquals(1, controller.unviewedDenialsCount.value)

        val record = controller.denials.value[0]
        assertEquals("firestore.rules:22:9", record.context.rule?.formattedCitation)
        assertEquals("delete", record.context.request?.method)
        assertFalse(record.isViewed)

        // Mark viewed
        controller.markDenialsViewed()
        advanceUntilIdle()
        assertEquals(0, controller.unviewedDenialsCount.value)
        assertTrue(controller.denials.value[0].isViewed)

        // Clear
        controller.clearDenials()
        advanceUntilIdle()
        assertTrue(controller.denials.value.isEmpty())
    }
}
